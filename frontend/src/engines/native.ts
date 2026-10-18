// Native playback: the browser's own HLS stack (`video.src = url`), as in
// Safari. Nothing to load and no MSE, so most internals are hidden. What we
// can see: the master playlist (fetched once more ourselves, for the ladder
// and rays), the rendered size (→ ray), ID3 metadata cues, the program date
// from getStartDate(), the seekable window, and Resource Timing entries
// where the browser exposes them. It shows where hls.js and the browser
// disagree.

import {videoProfile} from '../lib/codecs';
import type {Id3Frame} from '../lib/id3';
import {parseUplynkMedia, rayFromUri} from '../lib/rays';
import {rayFromSegmentUrl} from './shaka';
import {
    Emitter,
    type Listener,
    type MediaPlaylistInfo,
    type PlayerEngine,
    type Rendition,
    type RequestKind,
} from './types';

export const NATIVE_VERSION = 'browser';

/** True when the browser plays HLS in a plain <video> (Safari, iOS, some others). */
export function nativeHlsSupported(): boolean {
    return document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== '';
}

/** Safari's ID3 DataCue value: {key: 'TXXX', info, data} / {key: 'PRIV', info, data}. */
interface DataCueValue {
    key?: string;
    info?: string;
    data?: string | ArrayBuffer;
}

export class NativeEngine implements PlayerEngine {
    readonly name = 'Native';
    readonly version = NATIVE_VERSION;
    readonly limits =
        'The browser plays HLS itself, so requests, bandwidth estimate and ABR decisions are mostly hidden. ' +
        'Rays come from our own copy of the master playlist and the decoded frame size.';
    private video: HTMLVideoElement | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private current: Rendition | null = null;
    private master: string | null = null;
    private live = false;
    private abort = new AbortController();
    private observer: PerformanceObserver | null = null;
    private seenCues = new WeakSet<TextTrackCue>();

    on<K extends Parameters<PlayerEngine['on']>[0]>(event: K, listener: Listener<K>): void {
        this.events.on(event, listener);
    }

    load(url: string, video: HTMLVideoElement): void {
        this.video = video;
        void this.start(url, video);
    }

    private async start(url: string, video: HTMLVideoElement): Promise<void> {
        const {signal} = this.abort;
        const listen = (target: EventTarget, type: string, fn: (e: Event) => void) =>
            target.addEventListener(type, fn, {signal});

        this.observeRequests(url);
        // Our own copy of the master: the browser doesn't expose its ladder.
        const master = await fetchText(url, signal);
        if (signal.aborted) return;
        if (master) {
            this.master = master;
            this.renditions = parseMaster(master, url);
            const first = firstMediaUrl(master, url);
            const media = first ? await fetchText(first, signal) : null;
            if (signal.aborted) return;
            const info = media ? mediaPlaylistInfo(media, first ?? '') : null;
            if (info) this.events.emit('playlist', info);
            // Show the ladder now, even if the browser then refuses the stream.
            this.live = info?.live ?? true;
            this.events.emit('manifest', {
                renditions: this.renditions,
                master: this.master,
                live: this.live,
            });
        }

        listen(video, 'loadedmetadata', () => {
            this.live = !Number.isFinite(video.duration);
            this.events.emit('manifest', {
                renditions: this.renditions,
                master: this.master,
                live: this.live,
            });
            this.onResize();
            this.emitAudio();
        });
        listen(video, 'resize', () => this.onResize());
        listen(video, 'error', () => {
            const error = video.error;
            this.events.emit('error', {
                fatal: true,
                details: mediaErrorText(error?.code ?? 0, error?.message ?? ''),
                status: null,
                url: null,
            });
        });
        listen(video.textTracks, 'addtrack', (e) => {
            const track = (e as TrackEvent).track as TextTrack | null;
            if (track?.kind !== 'metadata') return;
            track.mode = 'hidden'; // deliver cues without rendering them
            listen(track, 'cuechange', () => this.onCues(track));
        });
        const audio = (video as unknown as {audioTracks?: EventTarget}).audioTracks;
        if (audio) listen(audio, 'change', () => this.emitAudio());

        video.src = url;
        void video.play().catch(() => {}); // autoplay may need a click
    }

    /** Resource Timing for the stream's host, where the browser reports it. */
    private observeRequests(url: string): void {
        if (typeof PerformanceObserver === 'undefined') return;
        let host: string;
        try {
            host = new URL(url).host;
        } catch {
            return;
        }
        this.observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
                if (entry.initiatorType === 'fetch') continue; // our own playlist fetches
                let entryHost: string;
                try {
                    entryHost = new URL(entry.name).host;
                } catch {
                    continue;
                }
                if (!entryHost.endsWith(host.replace(/^content(-\w+)?\./, ''))) continue;
                const kind = nativeRequestKind(entry.name);
                if (!kind) continue;
                const status = (entry as {responseStatus?: number}).responseStatus || null;
                const bytes = entry.transferSize || entry.encodedBodySize;
                const ray = rayFromSegmentUrl(entry.name) ?? rayFromUri(entry.name);
                const ms = Math.round(entry.responseEnd - entry.startTime);
                if (kind === 'segment') {
                    this.events.emit('segment', {ray, sn: '?', ms, bytes});
                }
                this.events.emit('request', {
                    kind,
                    name: kind === 'segment' ? `${ray ?? '·'} · seg` : kind,
                    start: entry.startTime,
                    end: entry.responseEnd,
                    status,
                    bytes,
                    failed: status !== null && status >= 400,
                });
            }
        });
        try {
            this.observer.observe({type: 'resource', buffered: false});
        } catch {
            this.observer = null;
        }
    }

    private onCues(track: TextTrack): void {
        for (const cue of Array.from(track.cues ?? [])) {
            if (this.seenCues.has(cue)) continue;
            this.seenCues.add(cue);
            const frame = dataCueFrame((cue as unknown as {value?: DataCueValue}).value);
            if (frame) this.events.emit('id3', {mediaTime: cue.startTime, frames: [frame]});
        }
    }

    private onResize(): void {
        const height = this.video?.videoHeight ?? 0;
        if (!height) return;
        const to = renditionForHeight(this.renditions, height);
        if (!to || to === this.current) return;
        this.events.emit('rendition', {from: this.current, to});
        this.current = to;
    }

    private emitAudio(): void {
        const list = (this.video as unknown as {audioTracks?: ArrayLike<NativeAudioTrack>})
            ?.audioTracks;
        if (!list) return;
        const tracks = Array.from(list).map((t, i) => ({
            id: i,
            name: t.label,
            lang: t.language,
            isDefault: i === 0,
        }));
        this.events.emit('audio', {tracks, current: Array.from(list).findIndex((t) => t.enabled)});
    }

    liveEdgeDrift(): number | null {
        const video = this.video;
        if (!this.live || !video?.seekable.length) return null;
        const drift = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        return Number.isFinite(drift) ? Math.max(0, drift) : null;
    }

    targetLatency(): number | null {
        return null;
    }

    /** Safari: getStartDate() is the PROGRAM-DATE-TIME at media time 0. */
    playingDate(): Date | null {
        const video = this.video as (HTMLVideoElement & {getStartDate?: () => Date}) | null;
        const start = video?.getStartDate?.().getTime();
        if (!video || start === undefined || !Number.isFinite(start)) return null;
        return new Date(start + video.currentTime * 1000);
    }

    bandwidthEstimate(): number | null {
        return null;
    }

    currentRendition(): Rendition | null {
        return this.current;
    }

    jumpToLive(): void {
        const video = this.video;
        if (video?.seekable.length) {
            video.currentTime = video.seekable.end(video.seekable.length - 1);
        }
    }

    setAudioTrack(id: number): void {
        const list = (this.video as unknown as {audioTracks?: ArrayLike<NativeAudioTrack>})
            ?.audioTracks;
        if (!list) return;
        Array.from(list).forEach((t, i) => {
            t.enabled = i === id;
        });
    }

    drmState(): null {
        return null; // FairPlay over native HLS arrives with #21
    }

    async destroy(): Promise<void> {
        this.abort.abort();
        this.observer?.disconnect();
        this.events.clear();
        if (this.video) {
            this.video.removeAttribute('src');
            this.video.load();
        }
    }
}

interface NativeAudioTrack {
    label: string;
    language: string;
    enabled: boolean;
}

// ------------------------------------------------------------------ helpers

/** MediaError code → what it means for native HLS. */
export function mediaErrorText(code: number, message: string): string {
    const names: Record<number, string> = {
        1: 'MEDIA_ERR_ABORTED',
        2: 'MEDIA_ERR_NETWORK',
        3: 'MEDIA_ERR_DECODE',
        4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
    };
    const hint =
        code === 4
            ? ' · this browser’s built-in HLS refused the stream (outside Safari it is often incomplete); use hls.js'
            : '';
    return `${names[code] ?? `MEDIA_ERR ${code}`}${message ? ` ${message}` : ''}${hint}`;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
    try {
        const response = await fetch(url, {signal, credentials: 'omit'});
        return response.ok ? await response.text() : null;
    } catch {
        return null;
    }
}

/** HLS master playlist → renditions (rays from the variant URIs). */
export function parseMaster(master: string, baseUrl: string): Rendition[] {
    const media = parseUplynkMedia(master);
    const lines = master.split(/\r?\n/).map((l) => l.trim());
    const out: Rendition[] = [];
    lines.forEach((line, i) => {
        if (!line.startsWith('#EXT-X-STREAM-INF:')) return;
        const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
        if (!uri) return;
        const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        const [w, hgt] = (attrs.RESOLUTION ?? '').split('x').map(Number);
        const ray = rayFromUri(resolve(uri, baseUrl));
        const m = ray ? media.get(ray) : undefined;
        out.push({
            index: 0,
            ray,
            width: w || m?.width || 0,
            height: hgt || m?.height || 0,
            bitrate: Number(attrs.BANDWIDTH ?? 0),
            codecs: attrs.CODECS ?? '',
            fps: Number(attrs['FRAME-RATE']) || m?.fps || null,
            profile: m?.profile ?? videoProfile(attrs.CODECS?.split(',')[0]),
        });
    });
    return out.sort((a, b) => a.bitrate - b.bitrate).map((r, index) => ({...r, index}));
}

export function parseAttributes(list: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const match of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        out[match[1] as string] = (match[2] as string).replace(/^"|"$/g, '');
    }
    return out;
}

function firstMediaUrl(master: string, baseUrl: string): string | null {
    const lines = master.split(/\r?\n/).map((l) => l.trim());
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF:'));
    const uri = i === -1 ? null : lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    return uri ? resolve(uri, baseUrl) : null;
}

function resolve(uri: string, base: string): string {
    try {
        return new URL(uri, base).href;
    } catch {
        return uri;
    }
}

/** A media playlist snapshot for the Manifest tab (native never shares its own). */
export function mediaPlaylistInfo(text: string, url: string): MediaPlaylistInfo {
    const tag = (name: string) => new RegExp(`^#${name}:(.*)$`, 'm').exec(text)?.[1] ?? null;
    const segments = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    const durations = [...text.matchAll(/^#EXTINF:([\d.]+)/gm)].map((m) => Number(m[1]));
    const firstSn = Number(tag('EXT-X-MEDIA-SEQUENCE') ?? 0);
    const first = segments[0] ?? '';
    return {
        format: 'hls',
        ray: rayFromUri(url),
        live: !/^#EXT-X-ENDLIST/m.test(text),
        targetDuration: Number(tag('EXT-X-TARGETDURATION') ?? 0),
        windowSeconds: durations.reduce((a, b) => a + b, 0),
        segments: segments.length,
        firstSn,
        lastSn: firstSn + Math.max(0, segments.length - 1),
        hasProgramDateTime: /^#EXT-X-PROGRAM-DATE-TIME/m.test(text),
        container: /^#EXT-X-MAP/m.test(text)
            ? 'fMP4'
            : /\.ts(\?|$)/i.test(first)
              ? 'TS'
              : 'unknown',
        text,
    };
}

/** The rendition the browser is showing, from the decoded frame height. */
export function renditionForHeight(renditions: Rendition[], height: number): Rendition | null {
    const same = renditions.filter((r) => r.height === height);
    if (same.length) return same[same.length - 1] as Rendition; // highest bitrate at that size
    let best: Rendition | null = null;
    for (const r of renditions) {
        if (!best || Math.abs(r.height - height) < Math.abs(best.height - height)) best = r;
    }
    return best;
}

export function nativeRequestKind(url: string): RequestKind | null {
    const path = url.split('?')[0] ?? '';
    if (/\.m3u8$/i.test(path)) return 'playlist';
    if (/\.(ts|m4[afsv]|mp4|aac|cmf[av])$/i.test(path)) return 'segment';
    if (/\/key|\.key$/i.test(path)) return 'key';
    return null;
}

/** Turn Safari's parsed ID3 DataCue back into the raw frame the UI reads. */
export function dataCueFrame(value: DataCueValue | undefined): Id3Frame | null {
    if (!value?.key) return null;
    const enc = new TextEncoder();
    const bytes = (d: string | ArrayBuffer | undefined) =>
        typeof d === 'string' ? enc.encode(d) : d ? new Uint8Array(d) : new Uint8Array();
    const join = (...parts: Uint8Array[]) => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const p of parts) {
            out.set(p, offset);
            offset += p.length;
        }
        return out;
    };
    const nul = new Uint8Array([0]);
    if (value.key === 'TXXX') {
        // encoding byte (3 = UTF-8), description, NUL, value
        return {
            id: 'TXXX',
            data: join(new Uint8Array([3]), bytes(value.info), nul, bytes(value.data)),
        };
    }
    if (value.key === 'PRIV') {
        return {id: 'PRIV', data: join(bytes(value.info), nul, bytes(value.data))};
    }
    return {id: value.key, data: bytes(value.data)};
}
