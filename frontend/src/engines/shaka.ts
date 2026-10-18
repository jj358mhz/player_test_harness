// Shaka Player adapter: DASH (and HLS) with Widevine / PlayReady DRM.
// Shaka ships a UMD build, so it's loaded with a <script> tag from jsDelivr
// (any version); the npm dependency supplies types and the default version.

import type shakaNS from 'shaka-player';
import {version as pinned} from 'shaka-player/package.json';
import {videoProfile} from '../lib/codecs';
import {
    type AudioTrack,
    type DrmConfig,
    type DrmState,
    Emitter,
    type Listener,
    type MediaPlaylistInfo,
    type PlayerEngine,
    type Rendition,
    type RequestKind,
} from './types';

export const DEFAULT_SHAKA_VERSION: string = pinned;

type Shaka = typeof shakaNS;
type ShakaPlayer = shakaNS.Player;
type Track = shakaNS.extern.Track;

const loaded = new Map<string, Promise<Shaka>>();

export function loadShaka(version: string): Promise<Shaka> {
    let promise = loaded.get(version);
    if (!promise) {
        promise = new Promise<Shaka>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `https://cdn.jsdelivr.net/npm/shaka-player@${encodeURIComponent(version)}/dist/shaka-player.compiled.js`;
            script.onload = () => {
                // Each version overwrites window.shaka; keep the one that just loaded.
                const ns = (window as unknown as {shaka?: Shaka}).shaka;
                if (ns) resolve(ns);
                else reject(new Error('shaka global missing'));
            };
            script.onerror = () => reject(new Error(`Could not load Shaka ${version}`));
            document.head.append(script);
        });
        promise.catch(() => loaded.delete(version));
        loaded.set(version, promise);
    }
    return promise;
}

/** Uplynk DASH uses the ray letter as the video Representation id (A…H). */
export function rayFromRepresentation(id: string | null | undefined): string | null {
    return id && /^[A-Za-z]{1,3}$/.test(id) ? id.toLowerCase() : null;
}

/** Uplynk segment files start with the ray letter: …/D00003391.m4s, …/F00003391.ts */
export function rayFromSegmentUrl(url: string): string | null {
    const match = /\/([A-Za-z])\d{5,}\.\w+(?:\?|$)/.exec(url); // .m4f, .m4s, .ts…
    return match ? (match[1] as string).toLowerCase() : null;
}

/** Plain-language help for the DRM errors people actually hit. */
export function drmHint(code: number): string | null {
    const hints: Record<number, string> = {
        6001: 'The browser has no usable CDM for this key system (Widevine needs Chrome/Edge/Firefox over HTTPS or localhost).',
        6002: 'The browser refused to create a DRM session.',
        6007: 'The license request failed. Check the license URL and that the token has not expired.',
        6008: 'The license server rejected the request (wrong key system, expired token or entitlement).',
        6012: 'No license server was configured for this key system.',
        6014: 'The license has expired.',
        6016: 'The CDM failed to process the license.',
    };
    return hints[code] ?? null;
}

const ROBUSTNESS: Record<DrmConfig['keySystem'], {video: string; audio: string}> = {
    'com.widevine.alpha': {video: 'SW_SECURE_DECODE', audio: 'SW_SECURE_CRYPTO'},
    'com.microsoft.playready': {video: '', audio: ''},
};

export class ShakaEngine implements PlayerEngine {
    readonly name = 'Shaka';
    /** Exposed for console debugging. */
    player: ShakaPlayer | null = null;
    private video: HTMLVideoElement | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private current: Rendition | null = null;
    private manifestText: string | null = null;
    private announced = false;

    constructor(
        private shaka: Shaka,
        readonly version: string,
        private drm: DrmConfig | null,
    ) {}

    on<K extends Parameters<PlayerEngine['on']>[0]>(event: K, listener: Listener<K>): void {
        this.events.on(event, listener);
    }

    load(url: string, video: HTMLVideoElement): void {
        void this.start(url, video);
    }

    private async start(url: string, video: HTMLVideoElement): Promise<void> {
        const {shaka} = this;
        shaka.polyfill.installAll();
        this.video = video;
        const player = new shaka.Player();
        this.player = player;
        await player.attach(video);

        const config: Record<string, unknown> = {
            streaming: {lowLatencyMode: false},
        };
        if (this.drm) {
            const r = ROBUSTNESS[this.drm.keySystem];
            config.drm = {
                servers: {[this.drm.keySystem]: this.drm.licenseUrl},
                advanced: {
                    [this.drm.keySystem]: {videoRobustness: [r.video], audioRobustness: [r.audio]},
                },
            };
        }
        player.configure(config);

        const RT = shaka.net.NetworkingEngine.RequestType;
        const net = player.getNetworkingEngine();
        net?.registerResponseFilter((type, response, context) => {
            const ms = response.timeMs ?? 0;
            const end = performance.now();
            const bytes = byteLength(response.data);
            const status = response.status ?? 200;
            if (type === RT.LICENSE) {
                this.events.emit('license', {
                    ms: Math.round(ms),
                    status,
                    bytes,
                    failed: false,
                    error: null,
                });
            }
            if (type === RT.MANIFEST) {
                // Live MPDs refresh every minimumUpdatePeriod; keep the latest.
                this.manifestText = new TextDecoder().decode(toBytes(response.data));
                this.events.emit('playlist', mpdInfo(this.manifestText));
            }
            const kind = requestKind(type, response.uri, RT);
            if (!kind) return;
            // Audio and text are separate DASH streams, not rays.
            const media = context?.stream?.type;
            const other = media === 'audio' || media === 'text' ? media : null;
            const ray = other
                ? null
                : (rayFromRepresentation(context?.stream?.originalId) ??
                  rayFromSegmentUrl(response.uri));
            if (kind === 'segment' && !other) {
                this.events.emit('segment', {
                    ray,
                    sn: segmentNumber(response.uri),
                    ms: Math.round(ms),
                    bytes,
                });
            }
            this.events.emit('request', {
                kind,
                name: requestName(kind, response.uri, other ?? ray),
                start: end - ms,
                end,
                status,
                bytes,
                failed: false,
            });
        });

        player.addEventListener('trackschanged', () => this.onTracks());
        player.addEventListener('variantchanged', () => this.onVariant());
        player.addEventListener('adaptation', () => this.onVariant());
        player.addEventListener('keystatuschanged', () =>
            this.events.emit('keystatus', {statuses: player.getKeyStatuses()}),
        );
        player.addEventListener('emsg', (event) => {
            const detail = (
                event as unknown as {
                    detail?: {schemeIdUri?: string; value?: string; messageData?: Uint8Array};
                }
            ).detail;
            if (!detail) return;
            this.events.emit('emsg', {
                scheme: detail.schemeIdUri ?? '',
                value: detail.value ?? '',
                bytes: detail.messageData?.byteLength ?? 0,
            });
        });
        player.addEventListener('error', (event) =>
            this.onError((event as unknown as {detail: shakaNS.util.Error}).detail),
        );

        try {
            await player.load(url);
        } catch (err) {
            this.onError(err as shakaNS.util.Error);
        }
    }

    private onTracks(): void {
        const player = this.player;
        if (!player) return;
        const byVideo = new Map<string, Track>();
        for (const t of player.getVariantTracks()) {
            const key = String(t.videoId ?? t.id);
            const existing = byVideo.get(key);
            if (!existing || t.bandwidth > existing.bandwidth) byVideo.set(key, t);
        }
        this.renditions = [...byVideo.values()]
            .sort((a, b) => (a.videoBandwidth ?? a.bandwidth) - (b.videoBandwidth ?? b.bandwidth))
            .map((t, index) => ({
                index,
                ray: rayFromRepresentation(t.originalVideoId),
                width: t.width ?? 0,
                height: t.height ?? 0,
                bitrate: t.videoBandwidth ?? t.bandwidth,
                codecs: [t.videoCodec, t.audioCodec].filter(Boolean).join(','),
                fps: t.frameRate ?? null,
                profile: videoProfile(t.videoCodec),
            }));
        if (!this.announced) {
            this.announced = true;
            this.events.emit('manifest', {
                renditions: this.renditions,
                master: this.manifestText,
                live: player.isLive(),
            });
        }
        this.emitAudio();
        this.onVariant();
    }

    private onVariant(): void {
        const to = this.currentRendition();
        if (!to || to.index === this.current?.index) return;
        this.events.emit('rendition', {from: this.current, to});
        this.current = to;
    }

    private emitAudio(): void {
        const player = this.player;
        if (!player) return;
        const tracks: AudioTrack[] = player.getAudioTracks().map((t, i) => ({
            id: i,
            name: t.label ?? '',
            lang: t.language,
            isDefault: t.primary,
        }));
        const current = player.getAudioTracks().findIndex((t) => t.active);
        this.events.emit('audio', {tracks, current});
    }

    private onError(error: shakaNS.util.Error | undefined): void {
        if (!error) return;
        const {shaka} = this;
        const codeName = Object.entries(shaka.util.Error.Code).find(
            ([, v]) => v === error.code,
        )?.[0];
        const category = Object.entries(shaka.util.Error.Category).find(
            ([, v]) => v === error.category,
        )?.[0];
        const data = (error.data ?? []) as unknown[];
        let status: number | null = null;
        let url: string | null = null;
        if (error.code === shaka.util.Error.Code.BAD_HTTP_STATUS) {
            url = typeof data[0] === 'string' ? data[0] : null;
            status = typeof data[1] === 'number' ? data[1] : null;
        }
        const hint = drmHint(error.code);
        const details = `${category ?? 'ERROR'} ${error.code}${codeName ? ` ${codeName}` : ''}${hint ? ` · ${hint}` : ''}`;
        if (error.category === shaka.util.Error.Category.DRM) {
            this.events.emit('license', {ms: 0, status, bytes: 0, failed: true, error: details});
        }
        if (url && status !== null) {
            const now = performance.now();
            this.events.emit('request', {
                kind: requestKind(-1, url, shaka.net.NetworkingEngine.RequestType) ?? 'segment',
                name: requestName('segment', url, rayFromSegmentUrl(url)),
                start: now,
                end: now,
                status,
                bytes: 0,
                failed: true,
            });
        }
        this.events.emit('error', {
            fatal: error.severity === shaka.util.Error.Severity.CRITICAL,
            details,
            status,
            url,
        });
    }

    liveEdgeDrift(): number | null {
        const player = this.player;
        if (!player?.isLive() || !this.video) return null;
        const drift = player.seekRange().end - this.video.currentTime;
        return Number.isFinite(drift) ? Math.max(0, drift) : null;
    }

    targetLatency(): number | null {
        return null;
    }

    playingDate(): Date | null {
        return this.player?.getPlayheadTimeAsDate() ?? null;
    }

    bandwidthEstimate(): number | null {
        const bwe = this.player?.getStats().estimatedBandwidth;
        return bwe && Number.isFinite(bwe) ? bwe : null;
    }

    currentRendition(): Rendition | null {
        const active = this.player?.getVariantTracks().find((t) => t.active);
        if (!active) return null;
        return (
            this.renditions.find(
                (r) => r.ray && r.ray === rayFromRepresentation(active.originalVideoId),
            ) ??
            this.renditions.find(
                (r) =>
                    r.height === active.height &&
                    r.bitrate === (active.videoBandwidth ?? active.bandwidth),
            ) ??
            null
        );
    }

    jumpToLive(): void {
        this.player?.goToLive();
    }

    setAudioTrack(id: number): void {
        const track = this.player?.getAudioTracks()[id];
        if (track) {
            this.player?.selectAudioTrack(track);
            this.emitAudio();
        }
    }

    drmState(): DrmState | null {
        const player = this.player;
        const info = player?.drmInfo();
        if (!player || !info) return null;
        const stats = player.getStats();
        const expiration = player.getExpiration();
        return {
            keySystem: info.keySystem || null,
            licenseServer: info.licenseServerUri || null,
            videoRobustness: info.videoRobustness || null,
            audioRobustness: info.audioRobustness || null,
            encryptionScheme: info.encryptionScheme || null,
            keyStatuses: player.getKeyStatuses(),
            licenseSeconds: Number.isFinite(stats.licenseTime) ? stats.licenseTime : null,
            expiration: Number.isFinite(expiration) ? expiration : null,
        };
    }

    async destroy(): Promise<void> {
        const player = this.player;
        this.player = null;
        this.events.clear();
        await player?.destroy(); // detaches MediaSource/MediaKeys from the video
    }
}

// ------------------------------------------------------------------ helpers

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    return data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function byteLength(data: ArrayBuffer | ArrayBufferView): number {
    return data.byteLength;
}

function requestKind(
    type: number,
    uri: string,
    RT: typeof shakaNS.net.NetworkingEngine.RequestType,
): RequestKind | null {
    if (type === RT.MANIFEST) return 'manifest';
    if (type === RT.LICENSE || type === RT.SERVER_CERTIFICATE) return 'license';
    if (type === RT.KEY) return 'key';
    if (type === RT.SEGMENT || type === -1)
        return /_init\.|init\.mp4/i.test(uri) ? 'init' : 'segment';
    return null;
}

function segmentNumber(uri: string): string {
    const match = /\/[A-Za-z_]*?(\d{5,})\./.exec(uri); // D00003391.m4f, TK_00005950.m4f
    return match ? String(Number(match[1])) : '?';
}

function requestName(kind: RequestKind, uri: string, ray: string | null): string {
    if (kind === 'manifest') return 'manifest.mpd';
    if (kind === 'license') return 'license';
    if (kind === 'init') return `${ray ?? '·'} · init`;
    return `${ray ?? '·'} · seg ${segmentNumber(uri)}`;
}

/** The MPD's own equivalents of the HLS playlist facts the Manifest tab shows. */
export function mpdInfo(mpd: string): MediaPlaylistInfo {
    const attr = (name: string) =>
        new RegExp(`<MPD[^>]*\\s${name}="([^"]*)"`).exec(mpd)?.[1] ?? null;
    const periods = (mpd.match(/<Period[\s>]/g) ?? []).length;
    const ads = (mpd.match(/urn:com:uplynk:ad-asset-id/g) ?? []).length;
    return {
        format: 'dash',
        ray: null,
        live: attr('type') === 'dynamic',
        targetDuration: isoSeconds(attr('maxSegmentDuration')) ?? 0,
        windowSeconds: isoSeconds(attr('timeShiftBufferDepth')) ?? 0,
        segments: 0,
        firstSn: 0,
        lastSn: 0,
        hasProgramDateTime: Boolean(attr('availabilityStartTime')),
        container: /mimeType="(video|audio)\/mp4"/.test(mpd) ? 'fMP4' : 'unknown',
        text: mpd,
        dash: {
            updatePeriod: isoSeconds(attr('minimumUpdatePeriod')),
            availabilityStart: attr('availabilityStartTime'),
            periods,
            adPeriods: ads,
            profiles: attr('profiles'),
        },
    };
}

/** ISO 8601 duration (PT1H2M3.5S) → seconds. */
export function isoSeconds(value: string | null): number | null {
    const m = value && /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
    if (!m) return null;
    const [, d, h, min, sec] = m;
    return (
        Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0)
    );
}
