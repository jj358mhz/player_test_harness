// dash.js adapter: DASH with Widevine / PlayReady. dash.js 5 ships an ESM
// build, loaded from jsDelivr like hls.js (any version); the npm dependency
// supplies types and the default version (bumped by Dependabot).

import type * as dashjsNS from 'dashjs';
import pkg from '../../package.json';
import type {CmcdConfig} from '../lib/cmcd';
import {videoProfile} from '../lib/codecs';
import {drmHint, mpdInfo, rayFromRepresentation, rayFromSegmentUrl} from './shaka';
import {
    type AudioTrack,
    type DrmConfig,
    type DrmState,
    Emitter,
    type Listener,
    type PlayerEngine,
    type Rendition,
    type RequestKind,
} from './types';

export const DEFAULT_DASHJS_VERSION: string = pkg.dependencies.dashjs;

type DashJs = typeof dashjsNS;
type MediaPlayer = dashjsNS.MediaPlayerClass;
type Representation = dashjsNS.Representation;
type MediaResponse = Parameters<Parameters<MediaPlayer['addResponseInterceptor']>[0]>[0];

const loaded = new Map<string, Promise<DashJs>>();

export function loadDashJs(version: string): Promise<DashJs> {
    let promise = loaded.get(version);
    if (!promise) {
        const url = `https://cdn.jsdelivr.net/npm/dashjs@${encodeURIComponent(version)}/dist/modern/esm/dash.all.min.js`;
        promise = import(/* @vite-ignore */ url) as Promise<DashJs>;
        promise.catch(() => loaded.delete(version));
        loaded.set(version, promise);
    }
    return promise;
}

const WIDEVINE_ROBUSTNESS = {
    videoRobustness: 'SW_SECURE_DECODE',
    audioRobustness: 'SW_SECURE_CRYPTO',
};

/** dash.js error codes that mean the stream can't play at all. */
const FATAL_CODES = new Set([10, 11, 23, 24, 25, 27, 31, 33, 34, 35]);

/** What dash.js tells us about a request in its customData. */
interface RequestContext {
    type?: string | null; // InitializationSegment | MediaSegment
    mediaType?: string; // video | audio | text
    representationId?: string;
}

export class DashJsEngine implements PlayerEngine {
    cmcd: CmcdConfig | null = null;
    readonly name = 'dash.js';
    /** Exposed for console debugging. */
    player: MediaPlayer | null = null;
    private video: HTMLVideoElement | null = null;
    /** dash.js clears these on reset(); the next engine expects them back. */
    private videoState: {autoplay: boolean; muted: boolean} | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private current: Rendition | null = null;
    private manifestText: string | null = null;
    private announced = false;
    private keyStatuses: Record<string, string> = {};
    /** KEY_MESSAGE times, oldest first: license requests can overlap. */
    private licenseStarts: number[] = [];
    private licenseMs = 0;
    private expiration: number | null = null;

    constructor(
        private dashjs: DashJs,
        readonly version: string,
        private drm: DrmConfig | null,
    ) {}

    on<K extends Parameters<PlayerEngine['on']>[0]>(event: K, listener: Listener<K>): void {
        this.events.on(event, listener);
    }

    load(url: string, video: HTMLVideoElement): void {
        const player = this.dashjs.MediaPlayer().create();
        this.player = player;
        this.video = video;
        this.videoState = {autoplay: video.autoplay, muted: video.muted};
        const E = this.dashjs.MediaPlayer.events;
        // Protection and period events aren't on MediaPlayer.events in every
        // build; the bus accepts their names directly.
        const on = (name: string, fn: (e: unknown) => void) =>
            (player.on as unknown as (n: string, f: (e: unknown) => void) => void)(name, fn);

        player.addResponseInterceptor(async (response) => {
            this.onResponse(response);
            return response;
        });
        player.on(E.STREAM_INITIALIZED, () => this.onStream());
        on('periodSwitchCompleted', () => this.readRenditions());
        player.on(E.QUALITY_CHANGE_RENDERED, (e) => {
            if (e.mediaType === 'video') this.onVariant(e.newRepresentation);
        });
        player.on(E.TRACK_CHANGE_RENDERED, () => this.emitAudio());
        on('public_keyMessage', () => {
            this.licenseStarts.push(performance.now());
        });
        on('public_licenseRequestComplete', (e) =>
            this.onLicense((e as dashjsNS.LicenseRequestCompleteEvent).error ?? null),
        );
        on('public_keyStatusesChanged', (e) => {
            const token = (e as dashjsNS.KeyStatusesChangedEvent).data;
            if (!token) return;
            token.getKeyStatuses().forEach((status, keyId) => {
                this.keyStatuses[hex(keyId)] = status;
            });
            const expiry = token.getExpirationTime();
            this.expiration = Number.isFinite(expiry) ? expiry : null;
            this.events.emit('keystatus', {statuses: {...this.keyStatuses}});
        });
        player.on(E.ERROR, (e) => this.onError(e as unknown as {error: dashjsNS.DashJSError}));
        player.on(E.PLAYBACK_ERROR, (e) => {
            const error = (e as unknown as {error?: MediaError}).error;
            this.events.emit('error', {
                fatal: true,
                details: `MEDIA ${error?.code ?? ''} ${error?.message ?? 'playback error'}`.trim(),
                status: null,
                url: null,
            });
        });

        player.updateSettings({
            streaming: {
                buffer: {fastSwitchEnabled: true},
                ...(this.cmcd
                    ? {
                          cmcd: {
                              enabled: true,
                              sid: this.cmcd.sessionId,
                              cid: this.cmcd.contentId,
                              mode: 'query' as const,
                          },
                      }
                    : {}),
            },
        });
        if (this.drm) {
            const robustness =
                this.drm.keySystem === 'com.widevine.alpha' ? WIDEVINE_ROBUSTNESS : {};
            player.setProtectionData({
                [this.drm.keySystem]: {serverURL: this.drm.licenseUrl, ...robustness},
            });
        }
        player.initialize(video, url, true);
    }

    private onResponse(response: MediaResponse): void {
        const url = response.url ?? response.request.url;
        if (this.isLicense(url)) return; // timed from KEY_MESSAGE → LICENSE_REQUEST_COMPLETE
        const timing = response.resourceTiming;
        const end = timing ? timing.startTime + timing.duration : performance.now();
        const start = timing ? timing.startTime : end;
        const bytes = timing?.encodedBodySize || byteLength(response.data);
        const status = response.status ?? 200;
        const context = (response.request.customData as {request?: RequestContext} | undefined)
            ?.request;
        const kind = requestKind(url, context);
        if (kind === 'manifest') {
            const text = textOf(response.data);
            if (text) {
                this.manifestText = text;
                this.events.emit('playlist', mpdInfo(text));
                this.useManifestLicense(text);
            }
        }
        if (!kind) return;
        const media = context?.mediaType;
        const other = media === 'audio' || media === 'text' ? media : null;
        const ray = other
            ? null
            : (rayFromRepresentation(context?.representationId) ?? rayFromSegmentUrl(url));
        if (kind === 'segment' && !other) {
            this.events.emit('segment', {
                ray,
                sn: segmentNumber(url),
                ms: Math.round(end - start),
                bytes,
            });
        }
        this.events.emit('request', {
            kind,
            name: requestName(kind, url, other ?? ray),
            start,
            end,
            status,
            bytes,
            failed: status >= 400,
        });
    }

    /**
     * Uplynk DASH is always CENC, even without Studio DRM, and the MPD names
     * its Widevine license URL in <ms:laurl>. Shaka reads that by itself;
     * dash.js needs it handed over. Runs before dash.js parses the MPD.
     */
    private useManifestLicense(mpd: string): void {
        if (this.drm || !this.player) return;
        const licenseUrl = mpdLicenseUrl(mpd);
        if (!licenseUrl) return;
        this.drm = {keySystem: 'com.widevine.alpha', licenseUrl};
        this.player.setProtectionData({
            'com.widevine.alpha': {serverURL: licenseUrl, ...WIDEVINE_ROBUSTNESS},
        });
    }

    private isLicense(url: string): boolean {
        return Boolean(this.drm && url.split('?')[0] === this.drm.licenseUrl.split('?')[0]);
    }

    private onLicense(error: dashjsNS.DashJSError | null): void {
        const end = performance.now();
        const start = this.licenseStarts.shift() ?? end;
        const ms = Math.round(end - start);
        this.licenseMs += ms;
        const message = error ? `DRM ${error.code ?? ''} ${error.message ?? ''}`.trim() : null;
        this.events.emit('license', {
            ms,
            status: error ? null : 200,
            bytes: 0,
            failed: Boolean(error),
            error: message,
        });
        this.events.emit('request', {
            kind: 'license',
            name: 'license',
            start,
            end,
            status: error ? null : 200,
            bytes: 0,
            failed: Boolean(error),
        });
    }

    private onStream(): void {
        this.readRenditions();
        if (!this.announced) {
            this.announced = true;
            this.events.emit('manifest', {
                renditions: this.renditions,
                master: this.manifestText,
                live: this.player?.isDynamic() ?? false,
            });
        }
        this.emitAudio();
        const current = this.player?.getCurrentRepresentationForType('video');
        if (current) this.onVariant(current);
    }

    /** Ad Periods have their own Representations; keep the ladder current. */
    private readRenditions(): void {
        const reps = this.player?.getRepresentationsByType('video') ?? [];
        if (!reps.length) return;
        this.renditions = [...reps]
            .sort((a, b) => a.bandwidth - b.bandwidth)
            .map((r, index) => toRendition(r, index));
    }

    private onVariant(rep: Representation | null | undefined): void {
        if (!rep) return;
        const ray = rayFromRepresentation(rep.id);
        const to =
            this.renditions.find((r) => r.ray && r.ray === ray) ??
            this.renditions.find((r) => r.bitrate === rep.bandwidth) ??
            toRendition(rep, this.renditions.length);
        if (to.index === this.current?.index && to.ray === this.current?.ray) return;
        this.events.emit('rendition', {from: this.current, to});
        this.current = to;
    }

    private emitAudio(): void {
        const player = this.player;
        if (!player) return;
        const all = player.getTracksFor('audio');
        const active = player.getCurrentTrackFor('audio');
        const tracks: AudioTrack[] = all.map((t, i) => ({
            id: i,
            name: (t.labels?.[0] as {text?: string} | undefined)?.text ?? t.id ?? '',
            lang: t.lang ?? '',
            isDefault: i === 0,
        }));
        this.events.emit('audio', {tracks, current: active ? all.indexOf(active) : -1});
    }

    private onError(event: {error: dashjsNS.DashJSError}): void {
        const {error} = event;
        const code = error?.code ?? 0;
        const data = (error?.data ?? {}) as {url?: string; request?: {url?: string}};
        const url = data.url ?? data.request?.url ?? null;
        const status = /\b([45]\d\d)\b/.exec(error?.message ?? '')?.[1];
        const isDrm = code >= 100 && code < 200;
        const hint = isDrm ? drmHint(6007) : null;
        const details = `ERROR ${code} ${error?.message ?? ''}`.trim() + (hint ? ` · ${hint}` : '');
        if (isDrm) {
            this.events.emit('license', {
                ms: 0,
                status: null,
                bytes: 0,
                failed: true,
                error: details,
            });
        }
        this.events.emit('error', {
            fatal: FATAL_CODES.has(code) || isDrm,
            details,
            status: status ? Number(status) : null,
            url,
        });
    }

    liveEdgeDrift(): number | null {
        const player = this.player;
        if (!player?.isDynamic()) return null;
        const drift = player.getDvrWindow().end - player.time();
        return Number.isFinite(drift) ? Math.max(0, drift) : null;
    }

    targetLatency(): number | null {
        const target = this.player?.isDynamic() ? this.player.getTargetLiveDelay() : NaN;
        return Number.isFinite(target) && target > 0 ? target : null;
    }

    playingDate(): Date | null {
        const player = this.player;
        if (!player?.isDynamic()) return null;
        const seconds = player.timeAsUTC();
        return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
    }

    bandwidthEstimate(): number | null {
        const kbps = this.player?.getAverageThroughput('video');
        return kbps && Number.isFinite(kbps) ? kbps * 1000 : null;
    }

    currentRendition(): Rendition | null {
        return this.current;
    }

    jumpToLive(): void {
        this.player?.seekToOriginalLive();
    }

    setAudioTrack(id: number): void {
        const track = this.player?.getTracksFor('audio')[id];
        if (track) this.player?.setCurrentTrack(track);
    }

    drmState(): DrmState | null {
        if (!this.drm || !this.player) return null;
        const widevine = this.drm.keySystem === 'com.widevine.alpha';
        return {
            keySystem: this.drm.keySystem,
            licenseServer: this.drm.licenseUrl,
            videoRobustness: widevine ? 'SW_SECURE_DECODE' : null,
            audioRobustness: widevine ? 'SW_SECURE_CRYPTO' : null,
            encryptionScheme: /value="cbcs"/i.test(this.manifestText ?? '') ? 'cbcs' : 'cenc',
            keyStatuses: {...this.keyStatuses},
            licenseSeconds: this.licenseMs / 1000,
            expiration: this.expiration,
        };
    }

    async destroy(): Promise<void> {
        const player = this.player;
        this.player = null;
        this.events.clear();
        player?.reset(); // tears down MediaSource and key sessions
        // reset() closes key sessions asynchronously; give it a tick before the
        // next engine sets its own MediaKeys on the same element.
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (this.video) {
            this.video.removeAttribute('src');
            this.video.load();
            if (this.videoState) Object.assign(this.video, this.videoState);
        }
    }
}

// ------------------------------------------------------------------ helpers

function toRendition(r: Representation, index: number): Rendition {
    return {
        index,
        ray: rayFromRepresentation(r.id),
        width: r.width ?? 0,
        height: r.height ?? 0,
        bitrate: r.bandwidth,
        codecs: r.codecs ?? '',
        fps: r.frameRate || null,
        profile: videoProfile(r.codecs ?? undefined),
    };
}

/** Classify a dash.js response from its request context, else the URL. */
export function requestKind(url: string, context?: RequestContext): RequestKind | null {
    if (context?.type === 'InitializationSegment') return 'init';
    if (context?.type === 'MediaSegment') return 'segment';
    const path = url.split('?')[0] ?? '';
    if (/\.mpd$/i.test(path)) return 'manifest';
    if (/_init\.|init\.mp4/i.test(path)) return 'init';
    if (/\.(m4[afsv]|mp4|cmf[av])$/i.test(path)) return 'segment';
    return null;
}

function segmentNumber(uri: string): string {
    const match = /\/[A-Za-z_]*?(\d{5,})\./.exec(uri); // D00003391.m4f, TK_00005950.m4f
    return match ? String(Number(match[1])) : '?';
}

function requestName(kind: RequestKind, uri: string, ray: string | null): string {
    if (kind === 'manifest') return 'manifest.mpd';
    if (kind === 'init') return `${ray ?? '·'} · init`;
    return `${ray ?? '·'} · seg ${segmentNumber(uri)}`;
}

function textOf(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
    if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
    return null;
}

function byteLength(data: unknown): number {
    if (typeof data === 'string') return data.length;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
    return 0;
}

/** The Widevine license URL an Uplynk MPD names in <ms:laurl licenseUrl="…">. */
export function mpdLicenseUrl(mpd: string): string | null {
    const match = /<(?:\w+:)?laurl\b[^>]*\blicenseUrl="([^"]+)"/i.exec(mpd);
    return match ? (match[1] as string).replace(/&amp;/g, '&') : null;
}

/** Key id from a MediaKeyStatusMap (BufferSource) as lowercase hex. */
export function hex(keyId: BufferSource): string {
    const bytes =
        keyId instanceof ArrayBuffer
            ? new Uint8Array(keyId)
            : new Uint8Array(keyId.buffer, keyId.byteOffset, keyId.byteLength);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
