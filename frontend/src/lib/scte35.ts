// SCTE-35 splice_info_section decoder (the parts triage needs): splice_insert,
// time_signal and segmentation descriptors. Uplynk carries these in ID3 PRIV
// frames; HLS DATERANGE tags carry the same bytes as hex.

class Bits {
    private pos = 0; // bit position

    constructor(private bytes: Uint8Array) {}

    read(n: number): number {
        let v = 0;
        for (let i = 0; i < n; i++) {
            const byte = this.bytes[this.pos >> 3];
            if (byte === undefined) throw new RangeError('SCTE-35 section truncated');
            v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
            this.pos++;
        }
        return v;
    }

    skip(n: number): void {
        this.pos += n;
    }

    get byte(): number {
        return this.pos >> 3;
    }

    seekByte(b: number): void {
        this.pos = b * 8;
    }
}

export const COMMAND_TYPES: Record<number, string> = {
    0: 'splice_null',
    4: 'splice_schedule',
    5: 'splice_insert',
    6: 'time_signal',
    7: 'bandwidth_reservation',
    255: 'private_command',
};

/** segmentation_type_id → [name, starts a break?, ends a break?] */
export const SEGMENTATION_TYPES: Record<number, [string, 'out' | 'in' | null]> = {
    16: ['Program Start', null],
    17: ['Program End', null],
    32: ['Chapter Start', null],
    33: ['Chapter End', null],
    34: ['Break Start', 'out'],
    35: ['Break End', 'in'],
    48: ['Provider Advertisement Start', 'out'],
    49: ['Provider Advertisement End', 'in'],
    50: ['Distributor Advertisement Start', 'out'],
    51: ['Distributor Advertisement End', 'in'],
    52: ['Provider Placement Opportunity Start', 'out'],
    53: ['Provider Placement Opportunity End', 'in'],
    54: ['Distributor Placement Opportunity Start', 'out'],
    55: ['Distributor Placement Opportunity End', 'in'],
    64: ['Unscheduled Event Start', null],
    65: ['Unscheduled Event End', null],
};

export interface Segmentation {
    eventId: number;
    cancel: boolean;
    typeId: number;
    typeName: string;
    duration: number | null; // seconds
    upidType: number;
    upid: string;
    segmentNum: number;
    segmentsExpected: number;
}

export interface SpliceInfo {
    command: string;
    commandType: number;
    ptsAdjustment: number;
    /** splice_insert */
    eventId?: number;
    cancel?: boolean;
    outOfNetwork?: boolean;
    immediate?: boolean;
    spliceTime?: number | null; // seconds (90 kHz pts / 90000)
    breakDuration?: number | null; // seconds
    autoReturn?: boolean;
    segmentations: Segmentation[];
    /** 'out' starts an ad break, 'in' ends one, null for anything else. */
    direction: 'out' | 'in' | null;
    /** Planned break length in seconds, when the cue says. */
    duration: number | null;
}

const ticks = (hi: number, lo32: number) => (hi * 2 ** 32 + lo32) / 90000;

function spliceTime(b: Bits): number | null {
    if (b.read(1)) {
        b.skip(6);
        return ticks(b.read(1), b.read(32));
    }
    b.skip(7);
    return null;
}

export function decodeScte35(bytes: Uint8Array): SpliceInfo {
    const b = new Bits(bytes);
    if (b.read(8) !== 0xfc) throw new Error('Not an SCTE-35 section (table_id != 0xFC)');
    b.skip(2); // section_syntax_indicator, private_indicator
    b.skip(2); // sap_type
    b.read(12); // section_length
    b.read(8); // protocol_version
    const encrypted = b.read(1);
    b.skip(6); // encryption_algorithm
    const ptsAdjustment = ticks(b.read(1), b.read(32));
    b.skip(8); // cw_index
    b.skip(12); // tier
    const commandLength = b.read(12);
    const commandType = b.read(8);
    const info: SpliceInfo = {
        command: COMMAND_TYPES[commandType] ?? `0x${commandType.toString(16)}`,
        commandType,
        ptsAdjustment,
        segmentations: [],
        direction: null,
        duration: null,
    };
    if (encrypted) return info;

    const commandStart = b.byte;
    if (commandType === 0x05) {
        info.eventId = b.read(32);
        info.cancel = Boolean(b.read(1));
        b.skip(7);
        if (!info.cancel) {
            info.outOfNetwork = Boolean(b.read(1));
            const programSplice = b.read(1);
            const durationFlag = b.read(1);
            info.immediate = Boolean(b.read(1));
            b.skip(4);
            if (programSplice && !info.immediate) info.spliceTime = spliceTime(b);
            if (!programSplice) {
                const components = b.read(8);
                for (let i = 0; i < components; i++) {
                    b.skip(8);
                    if (!info.immediate) spliceTime(b);
                }
            }
            if (durationFlag) {
                info.autoReturn = Boolean(b.read(1));
                b.skip(6);
                info.breakDuration = ticks(b.read(1), b.read(32));
            }
            b.read(16); // unique_program_id
            b.read(8); // avail_num
            b.read(8); // avails_expected
            info.direction = info.outOfNetwork ? 'out' : 'in';
            info.duration = info.breakDuration ?? null;
        }
    } else if (commandType === 0x06) {
        info.spliceTime = spliceTime(b);
    }
    if (commandLength !== 0xfff) b.seekByte(commandStart + commandLength);

    // descriptor loop
    const loopLength = b.read(16);
    const loopEnd = b.byte + loopLength;
    while (b.byte + 2 <= loopEnd) {
        const tag = b.read(8);
        const length = b.read(8);
        const next = b.byte + length;
        if (tag === 0x02 && length >= 9) {
            b.read(32); // identifier "CUEI"
            const eventId = b.read(32);
            const cancel = Boolean(b.read(1));
            b.skip(7);
            if (!cancel) {
                const programSegmentation = b.read(1);
                const durationFlag = b.read(1);
                const deliveryNotRestricted = b.read(1);
                if (!deliveryNotRestricted) b.skip(5);
                else b.skip(5);
                if (!programSegmentation) {
                    const components = b.read(8);
                    b.skip(components * 48);
                }
                const duration = durationFlag ? ticks(b.read(8), b.read(32)) : null;
                const upidType = b.read(8);
                const upidLength = b.read(8);
                const upidBytes: number[] = [];
                for (let i = 0; i < upidLength; i++) upidBytes.push(b.read(8));
                const typeId = b.read(8);
                const segmentNum = b.read(8);
                const segmentsExpected = b.read(8);
                info.segmentations.push({
                    eventId,
                    cancel,
                    typeId,
                    typeName: SEGMENTATION_TYPES[typeId]?.[0] ?? `type 0x${typeId.toString(16)}`,
                    duration,
                    upidType,
                    upid: upidText(upidBytes),
                    segmentNum,
                    segmentsExpected,
                });
            } else {
                info.segmentations.push({
                    eventId,
                    cancel,
                    typeId: 0,
                    typeName: 'cancelled',
                    duration: null,
                    upidType: 0,
                    upid: '',
                    segmentNum: 0,
                    segmentsExpected: 0,
                });
            }
        }
        b.seekByte(next);
    }

    if (info.direction === null) {
        for (const seg of info.segmentations) {
            const dir = SEGMENTATION_TYPES[seg.typeId]?.[1] ?? null;
            if (dir) {
                info.direction = dir;
                info.duration = seg.duration;
                break;
            }
        }
    }
    return info;
}

function upidText(bytes: number[]): string {
    if (!bytes.length) return '';
    const printable = bytes.every((c) => c >= 0x20 && c < 0x7f);
    return printable
        ? String.fromCharCode(...bytes)
        : bytes.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** One-line summary for logs. */
export function describeScte35(info: SpliceInfo): string {
    const parts: string[] = [info.command];
    if (info.commandType === 0x05) {
        if (info.cancel) parts.push(`event ${info.eventId} cancelled`);
        else {
            parts.push(info.outOfNetwork ? 'CUE-OUT' : 'CUE-IN', `event ${info.eventId}`);
            if (info.breakDuration) parts.push(`${info.breakDuration.toFixed(1)} s`);
            if (info.immediate) parts.push('immediate');
        }
    }
    for (const seg of info.segmentations) {
        parts.push(`${seg.typeName}${seg.duration ? ` ${seg.duration.toFixed(1)} s` : ''}`);
        if (seg.upid) parts.push(`upid ${seg.upid}`);
    }
    return parts.join(' · ');
}

export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/^0x/i, '').replace(/\s/g, '');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
}
