// Native playback: the browser's own HLS stack (`video.src = url`), as in
// Safari. Nothing to load and no MSE, so most internals are hidden. What we
// can see: the master playlist (fetched once more ourselves, for the ladder
// and rays), the rendered size (→ ray), ID3 metadata cues, the program date
// from getStartDate(), the seekable window, and Resource Timing entries
// where the browser exposes them. It shows where hls.js and the browser
// disagree.
//
// With a FairPlayConfig it also plays Studio DRM (FairPlay over HLS): the
// certificate from Preplay, one key session per skd:// key URI, and the
// SPC/CKC exchange with Uplynk's key server (lib/fairplay.ts). Uplynk's
// FairPlay segments are MPEG-TS, which Safari only decrypts through the
// older WebKit-prefixed EME (WebKitMediaKeys, `webkitneedkey`); standard
// EME (`encrypted`) is used for fMP4.

import {videoProfile} from '../lib/codecs';
import {
    certificateBytes,
    ckcFromResponse,
    contentIdFromSkd,
    FAIRPLAY_KEY_SYSTEM,
    FAIRPLAY_LEGACY_KEY_SYSTEM,
    fairplayKeyUri,
    keyIdHex,
    legacyInitData,
    licenseUrlFromSkd,
    skdFromInitData,
    spcRequestBody,
} from '../lib/fairplay';
import type {Id3Frame} from '../lib/id3';
import {parseUplynkMedia, rayFromUri} from '../lib/rays';
import {rayFromSegmentUrl} from './shaka';
import {
    type DrmState,
    Emitter,
    type FairPlayConfig,
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
/** Safari's WebKit-prefixed EME (not in lib.dom). */
interface WebKitKeySession extends EventTarget {
    update(key: Uint8Array): void;
    close(): void;
    error: {code: number; systemCode: number} | null;
}
interface WebKitKeys {
    createSession(type: string, initData: Uint8Array): WebKitKeySession;
}
interface WebKitKeysConstructor {
    new (keySystem: string): WebKitKeys;
    isTypeSupported(keySystem: string, type?: string): boolean;
}
type WebKitVideo = HTMLVideoElement & {
    webkitKeys?: WebKitKeys | null;
    webkitSetMediaKeys?: (keys: WebKitKeys | null) => void;
};

/** Safari's legacy FairPlay EME, if this browser has it. */
function legacyFairPlay(): WebKitKeysConstructor | null {
    const ctor = (window as unknown as {WebKitMediaKeys?: WebKitKeysConstructor}).WebKitMediaKeys;
    try {
        return ctor?.isTypeSupported(FAIRPLAY_LEGACY_KEY_SYSTEM, 'video/mp4') ? ctor : null;
    } catch {
        return null;
    }
}

interface DataCueValue {
    key?: string;
    info?: string;
    data?: string | ArrayBuffer;
}

export class NativeEngine implements PlayerEngine {
    readonly name = 'Native';
    readonly version = NATIVE_VERSION;
    readonly limits: string;
    private video: HTMLVideoElement | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private current: Rendition | null = null;
    private master: string | null = null;
    private live = false;
    private abort = new AbortController();
    private observer: PerformanceObserver | null = null;
    private seenCues = new WeakSet<TextTrackCue>();
    // FairPlay
    private mediaKeys: MediaKeys | null = null;
    /** skd:// URI (or init data hex) → its session. */
    private keySessions = new Map<string, MediaKeySession>();
    /** Legacy WebKit sessions and their statuses (no keyStatuses map there). */
    private legacySessions = new Map<string, WebKitKeySession>();
    private legacyStatuses: Record<string, string> = {};
    private legacy = false;
    private container: MediaPlaylistInfo['container'] = 'unknown';
    /** From our copy of the first media playlist, if init data doesn't carry it. */
    private keyUri: string | null = null;
    private licenseUrl: string | null = null;
    private licenseMs = 0;

    constructor(private fairplay: FairPlayConfig | null = null) {
        this.limits =
            'The browser plays HLS itself, so requests, bandwidth estimate and ABR decisions are mostly hidden. ' +
            'Rays come from our own copy of the master playlist and the decoded frame size.' +
            (fairplay
                ? ' FairPlay: license requests are timed here; segment and key timing stay inside Safari.'
                : '');
    }

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
            this.keyUri = media ? fairplayKeyUri(media) : null;
            if (info) this.container = info.container;
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
            const noKey =
                this.fairplay && !this.keySessions.size && !this.legacySessions.size
                    ? ` · FairPlay: Safari never asked for a key (no ${this.legacy ? 'webkitneedkey' : 'encrypted'} event)`
                    : '';
            this.events.emit('error', {
                fatal: true,
                details: mediaErrorText(error?.code ?? 0, error?.message ?? '') + noKey,
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

        if (this.fairplay && !(await this.setUpFairPlay(this.fairplay, video, signal))) return;
        if (signal.aborted) return;
        video.src = url;
        void video.play().catch(() => {}); // autoplay may need a click
    }

    // ------------------------------------------------------------ FairPlay

    private fail(details: string, status: number | null = null, url: string | null = null): false {
        this.events.emit('error', {fatal: true, details, status, url});
        return false;
    }

    /**
     * Key handling, set up before video.src: legacy WebKit EME for TS (and
     * when the container is unknown), standard EME for fMP4.
     */
    private async setUpFairPlay(
        config: FairPlayConfig,
        video: HTMLVideoElement,
        signal: AbortSignal,
    ): Promise<boolean> {
        const Legacy = this.container === 'fMP4' ? null : legacyFairPlay();
        if (Legacy) {
            this.legacy = true;
            const certificate = await this.fetchCertificate(config.certificateUrl, signal);
            if (!certificate) return false;
            video.addEventListener(
                'webkitneedkey',
                (e) =>
                    this.onNeedKey(
                        e as Event & {initData?: Uint8Array},
                        video,
                        Legacy,
                        certificate,
                    ),
                {signal},
            );
            return true;
        }
        if (!navigator.requestMediaKeySystemAccess)
            return this.fail(
                'No Encrypted Media Extensions here: FairPlay needs Safari 14 or later.',
            );
        let keys: MediaKeys;
        try {
            // Apple's samples ask for video/mp4; some Safari builds want the HLS type.
            const options = (contentType: string): MediaKeySystemConfiguration => ({
                initDataTypes: ['skd', 'sinf'],
                videoCapabilities: [{contentType, robustness: ''}],
                distinctiveIdentifier: 'not-allowed',
                persistentState: 'not-allowed',
                sessionTypes: ['temporary'],
            });
            const access = await navigator.requestMediaKeySystemAccess(FAIRPLAY_KEY_SYSTEM, [
                options('video/mp4'),
                options('application/vnd.apple.mpegurl'),
            ]);
            keys = await access.createMediaKeys();
        } catch (err) {
            return this.fail(
                `FairPlay (${FAIRPLAY_KEY_SYSTEM}) is not available in this browser: ${(err as Error).message}`,
            );
        }
        const certificate = await this.fetchCertificate(config.certificateUrl, signal);
        if (!certificate) return false;
        try {
            await keys.setServerCertificate(certificate as Uint8Array<ArrayBuffer>);
            await video.setMediaKeys(keys);
        } catch (err) {
            return this.fail(`FairPlay rejected the certificate: ${(err as Error).message}`);
        }
        if (signal.aborted) return false;
        this.mediaKeys = keys;
        video.addEventListener(
            'encrypted',
            (e) => void this.onEncrypted(e as MediaEncryptedEvent),
            {
                signal,
            },
        );
        return true;
    }

    /** The application certificate (DER), timed into the waterfall; null on failure. */
    private async fetchCertificate(url: string, signal: AbortSignal): Promise<Uint8Array | null> {
        const start = performance.now();
        let response: Response;
        let body: ArrayBuffer;
        try {
            response = await fetch(url, {signal, credentials: 'omit'});
            body = await response.arrayBuffer();
        } catch (err) {
            if (signal.aborted) return null;
            this.fail(
                `FairPlay certificate request failed: ${(err as Error).message} (blocked by CORS?)`,
                null,
                url,
            );
            return null;
        }
        this.events.emit('request', {
            kind: 'license',
            name: 'certificate',
            start,
            end: performance.now(),
            status: response.status,
            bytes: body.byteLength,
            failed: !response.ok,
            url,
        });
        if (!response.ok) {
            this.fail(
                `FairPlay certificate request failed (HTTP ${response.status})`,
                response.status,
                url,
            );
            return null;
        }
        return certificateBytes(body);
    }

    /** Legacy WebKit EME: one session per skd:// URI (Apple's FPS sample flow). */
    private onNeedKey(
        event: Event & {initData?: Uint8Array},
        video: WebKitVideo,
        Legacy: WebKitKeysConstructor,
        certificate: Uint8Array,
    ): void {
        const initData = event.initData;
        if (!initData) return;
        const skd = skdFromInitData(initData) ?? this.keyUri;
        const licenseUrl = skd ? licenseUrlFromSkd(skd) : null;
        if (!skd || !licenseUrl) {
            this.fail('FairPlay: no skd:// key URI in the init data or the media playlist.');
            return;
        }
        if (this.legacySessions.has(skd)) return;
        try {
            if (!video.webkitKeys)
                video.webkitSetMediaKeys?.(new Legacy(FAIRPLAY_LEGACY_KEY_SYSTEM));
            const keys = video.webkitKeys;
            if (!keys) throw new Error('webkitSetMediaKeys did not take');
            const session = keys.createSession(
                'video/mp4',
                legacyInitData(initData, contentIdFromSkd(skd), certificate),
            );
            this.legacySessions.set(skd, session);
            this.setLegacyStatus(skd, 'status-pending');
            session.addEventListener('webkitkeymessage', (e) => {
                const spc = (e as Event & {message: Uint8Array}).message;
                void this.requestLicense((ckc) => session.update(ckc), licenseUrl, spc);
            });
            session.addEventListener('webkitkeyadded', () => this.setLegacyStatus(skd, 'usable'));
            session.addEventListener('webkitkeyerror', () => {
                this.setLegacyStatus(skd, 'internal-error');
                const err = session.error;
                this.licenseFailed(
                    `FairPlay key error${err ? ` (code ${err.code}, system code ${err.systemCode})` : ''}`,
                );
            });
        } catch (err) {
            this.licenseFailed(`FairPlay could not start a key request: ${(err as Error).message}`);
        }
    }

    private setLegacyStatus(skd: string, status: string): void {
        // No key ids in the legacy API: name the key by the skd:// URI's last path part.
        const name = skd.split(/[?#]/)[0]?.split('/').pop() || contentIdFromSkd(skd);
        this.legacyStatuses[name] = status;
        this.events.emit('keystatus', {statuses: this.keyStatuses()});
    }

    /** One session per key: Uplynk may rotate keys or use one per ray. */
    private async onEncrypted(event: MediaEncryptedEvent): Promise<void> {
        const keys = this.mediaKeys;
        if (!keys || !event.initData) return;
        const skd = skdFromInitData(event.initData) ?? this.keyUri;
        const id = skd ?? keyIdHex(event.initData);
        if (this.keySessions.has(id)) return;
        const licenseUrl = skd ? licenseUrlFromSkd(skd) : null;
        if (!licenseUrl) {
            this.fail('FairPlay: no skd:// key URI in the init data or the media playlist.');
            return;
        }
        const session = keys.createSession('temporary');
        this.keySessions.set(id, session);
        session.addEventListener('message', (e) => {
            void this.requestLicense(
                (ckc) => session.update(ckc as Uint8Array<ArrayBuffer>),
                licenseUrl,
                (e as MediaKeyMessageEvent).message,
            );
        });
        session.addEventListener('keystatuseschange', () => {
            this.events.emit('keystatus', {statuses: this.keyStatuses()});
        });
        try {
            await session.generateRequest(event.initDataType, event.initData);
        } catch (err) {
            this.licenseFailed(`FairPlay could not start a key request: ${(err as Error).message}`);
        }
    }

    /** SPC → Uplynk's key server → CKC → the CDM. */
    private async requestLicense(
        update: (ckc: Uint8Array) => unknown,
        url: string,
        spc: ArrayBuffer | Uint8Array,
    ): Promise<void> {
        this.licenseUrl = url;
        const start = performance.now();
        let status: number | null = null;
        let bytes = 0;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: spcRequestBody(spc),
                credentials: 'omit',
                signal: this.abort.signal,
            });
            status = response.status;
            const text = await response.text();
            bytes = text.length;
            const end = performance.now();
            this.licenseMs += end - start;
            this.events.emit('request', {
                kind: 'license',
                name: 'license',
                start,
                end,
                status,
                bytes,
                failed: !response.ok,
                url,
            });
            if (!response.ok)
                throw new Error(`HTTP ${status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
            await update(ckcFromResponse(text));
            this.events.emit('license', {
                ms: Math.round(end - start),
                status,
                bytes,
                failed: false,
                error: null,
            });
        } catch (err) {
            if (this.abort.signal.aborted) return;
            this.licenseFailed(
                `FairPlay license request failed: ${(err as Error).message}`,
                status,
            );
        }
    }

    private licenseFailed(error: string, status: number | null = null): void {
        this.events.emit('license', {ms: 0, status, bytes: 0, failed: true, error});
        this.fail(error, status, this.licenseUrl);
    }

    private keyStatuses(): Record<string, string> {
        const out: Record<string, string> = {...this.legacyStatuses};
        for (const session of this.keySessions.values()) {
            session.keyStatuses.forEach((status, id) => {
                out[keyIdHex(id)] = status;
            });
        }
        return out;
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

    drmState(): DrmState | null {
        if (!this.fairplay) return null;
        const expiries = [...this.keySessions.values()]
            .map((s) => s.expiration)
            .filter((t) => Number.isFinite(t));
        return {
            keySystem: this.legacy ? FAIRPLAY_LEGACY_KEY_SYSTEM : FAIRPLAY_KEY_SYSTEM,
            licenseServer: this.licenseUrl,
            videoRobustness: null,
            audioRobustness: null,
            encryptionScheme: 'SAMPLE-AES (cbcs)',
            keyStatuses: this.keyStatuses(),
            licenseSeconds: this.licenseMs ? this.licenseMs / 1000 : null,
            expiration: expiries.length ? Math.min(...expiries) : null,
        };
    }

    async destroy(): Promise<void> {
        this.abort.abort();
        this.observer?.disconnect();
        this.events.clear();
        for (const session of this.keySessions.values()) void session.close().catch(() => {});
        this.keySessions.clear();
        for (const session of this.legacySessions.values()) {
            try {
                session.close();
            } catch {
                // already closed
            }
        }
        this.legacySessions.clear();
        if (this.video) {
            this.video.removeAttribute('src');
            this.video.load();
            if (this.mediaKeys) await this.video.setMediaKeys(null).catch(() => {});
            const video = this.video as WebKitVideo;
            if (video.webkitKeys) {
                try {
                    video.webkitSetMediaKeys?.(null);
                } catch {
                    // Safari may refuse while detaching; the next load sets new keys
                }
            }
        }
        this.mediaKeys = null;
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
