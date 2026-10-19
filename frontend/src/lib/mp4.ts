// The few ISO BMFF boxes we read from DASH segments, for latency.
//
// `prft` (ProducerReferenceTime) pairs an NTP wall-clock time with a media
// time of the reference track; `tfdt` is the fragment's first decode time;
// the init segment's `mdhd` gives the timescale. Box headers aren't
// encrypted under CENC, so this works on DRM'd segments too.

/** Seconds from the NTP epoch (1900) to the Unix epoch (1970). */
const NTP_UNIX_S = 2208988800;

export interface Prft {
    /** 0 encoder, 16 application, 24 captured (ISO/IEC 23009-1 types). */
    flags: number;
    trackId: number;
    /** Wall-clock time as Unix milliseconds. */
    wallMs: number;
    /** In the reference track's timescale. */
    mediaTime: number;
}

export interface SegmentBoxes {
    prft: Prft[];
    /** baseMediaDecodeTime of the first traf, in the track's timescale. */
    tfdt: number | null;
}

const CONTAINERS = new Set(['moof', 'traf', 'moov', 'trak', 'mdia']);

interface Box {
    type: string;
    /** Payload start (after the header) and end, absolute. */
    start: number;
    end: number;
}

function* boxes(view: DataView, from: number, to: number): Generator<Box> {
    let offset = from;
    while (offset + 8 <= to) {
        let size = view.getUint32(offset);
        const type = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7),
        );
        let header = 8;
        if (size === 1) {
            if (offset + 16 > to) return;
            size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
            header = 16;
        } else if (size === 0) {
            size = to - offset;
        }
        if (size < header || offset + size > to) return; // truncated or garbage
        yield {type, start: offset + header, end: offset + size};
        offset += size;
    }
}

function* walk(view: DataView, from: number, to: number): Generator<Box> {
    for (const box of boxes(view, from, to)) {
        yield box;
        if (CONTAINERS.has(box.type)) yield* walk(view, box.start, box.end);
    }
}

const u64 = (view: DataView, at: number) => view.getUint32(at) * 2 ** 32 + view.getUint32(at + 4);

function viewOf(data: ArrayBuffer | ArrayBufferView): DataView {
    return data instanceof ArrayBuffer
        ? new DataView(data)
        : new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function parsePrft(view: DataView, box: Box): Prft | null {
    const version = view.getUint8(box.start);
    const need = version === 0 ? 20 : 24;
    if (box.end - box.start < need) return null;
    const flags = (view.getUint8(box.start + 1) << 16) | view.getUint16(box.start + 2);
    const trackId = view.getUint32(box.start + 4);
    const sec = view.getUint32(box.start + 8);
    const frac = view.getUint32(box.start + 12);
    const mediaTime = version === 0 ? view.getUint32(box.start + 16) : u64(view, box.start + 16);
    return {flags, trackId, wallMs: (sec - NTP_UNIX_S) * 1000 + (frac / 2 ** 32) * 1000, mediaTime};
}

/** prft boxes and the first tfdt of a media segment. */
export function readSegmentBoxes(data: ArrayBuffer | ArrayBufferView): SegmentBoxes {
    const view = viewOf(data);
    const out: SegmentBoxes = {prft: [], tfdt: null};
    for (const box of walk(view, 0, view.byteLength)) {
        if (box.type === 'prft') {
            const prft = parsePrft(view, box);
            if (prft) out.prft.push(prft);
        } else if (box.type === 'tfdt' && out.tfdt === null && box.end - box.start >= 8) {
            const version = view.getUint8(box.start);
            out.tfdt = version === 1 ? u64(view, box.start + 4) : view.getUint32(box.start + 4);
        } else if (box.type === 'mdat') {
            break; // nothing we read comes after the media data
        }
    }
    return out;
}

/** The media timescale from an init segment's first mdhd. */
export function initTimescale(data: ArrayBuffer | ArrayBufferView): number | null {
    const view = viewOf(data);
    for (const box of walk(view, 0, view.byteLength)) {
        if (box.type !== 'mdhd') continue;
        const version = view.getUint8(box.start);
        const at = box.start + (version === 1 ? 20 : 12);
        return at + 4 <= box.end ? view.getUint32(at) || null : null;
    }
    return null;
}

/**
 * Wall-clock time (Unix ms) of the segment's first sample: the prft's time,
 * moved back by how far its media time sits past tfdt. Without a timescale
 * or tfdt, the prft time itself (packagers usually stamp the segment start).
 */
export function wallAtSegmentStart(
    prft: Prft,
    tfdt: number | null,
    timescale: number | null,
): number {
    if (tfdt === null || !timescale) return prft.wallMs;
    return prft.wallMs - ((prft.mediaTime - tfdt) / timescale) * 1000;
}

export const PRFT_TYPES: Record<number, string> = {0: 'encoder', 16: 'application', 24: 'captured'};

export interface PrftAnchor {
    /** Presentation time (video.currentTime) of the segment's start. */
    start: number;
    /** Wall-clock time of that moment, Unix ms. */
    wallMs: number;
    /** 'encoder', 'application' or 'captured'. */
    type: string;
}

/** Per engine: the video init's timescale, then an anchor from each media segment. */
export class PrftReader {
    private timescale: number | null = null;

    onInit(data: ArrayBuffer | ArrayBufferView): void {
        this.timescale = initTimescale(data) ?? this.timescale;
    }

    /** `start` is the segment's presentation start; null if it has no prft. */
    onSegment(data: ArrayBuffer | ArrayBufferView, start: number | undefined): PrftAnchor | null {
        if (start === undefined || !Number.isFinite(start)) return null;
        const {prft, tfdt} = readSegmentBoxes(data);
        const first = prft[0];
        if (!first) return null;
        return {
            start,
            wallMs: wallAtSegmentStart(first, tfdt, this.timescale),
            type: PRFT_TYPES[first.flags] ?? `flags ${first.flags}`,
        };
    }
}

/** An emsg payload for the log: its text if it's printable, else leading hex. */
export function payloadPreview(data: Uint8Array | undefined, max = 120): string {
    if (!data?.length) return '';
    const printable = data.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
    if (printable) {
        const text = new TextDecoder().decode(data).replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max)}…` : text;
    }
    const hex = Array.from(data.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join('');
    return data.length > 32 ? `0x${hex}…` : `0x${hex}`;
}
