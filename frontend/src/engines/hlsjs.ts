// hls.js adapter. The library itself is loaded at runtime from jsDelivr so
// any version can be picked; the npm dependency supplies types and the
// default version (bumped by Dependabot).

import type HlsType from 'hls.js';
import type {Fragment, Level, LoaderStats} from 'hls.js';
import {version as pinned} from 'hls.js/package.json';
import type {CmcdConfig} from '../lib/cmcd';
import {videoProfile} from '../lib/codecs';
import {parseId3} from '../lib/id3';
import {ptsToSeconds} from '../lib/latency';
import {parseUplynkMedia, rayFromUri, type UplynkMedia} from '../lib/rays';
import {Emitter, type Listener, type PlayerEngine, type Rendition, type RequestKind} from './types';

export const DEFAULT_HLS_VERSION: string = pinned;

type HlsClass = typeof HlsType;
const loaded = new Map<string, Promise<HlsClass>>();

export function loadHlsJs(version: string): Promise<HlsClass> {
    let promise = loaded.get(version);
    if (!promise) {
        const url = `https://cdn.jsdelivr.net/npm/hls.js@${encodeURIComponent(version)}/dist/hls.mjs`;
        promise = import(/* @vite-ignore */ url).then((m: {default: HlsClass}) => m.default);
        promise.catch(() => loaded.delete(version));
        loaded.set(version, promise);
    }
    return promise;
}

export class HlsJsEngine implements PlayerEngine {
    cmcd: CmcdConfig | null = null;
    readonly name = 'hls.js';
    private hls: HlsType | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private media = new Map<string, UplynkMedia>();
    private lastCc: number | null = null;
    private keyStarted = new Map<string, number>();
    private asset: string | null = null;
    private dateRanges = new Set<string>();

    constructor(
        private Hls: HlsClass,
        readonly version: string,
    ) {}

    on<K extends Parameters<PlayerEngine['on']>[0]>(event: K, listener: Listener<K>): void {
        this.events.on(event, listener);
    }

    load(url: string, video: HTMLVideoElement): void {
        const {Hls} = this;
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            ...(this.cmcd
                ? {
                      cmcd: {
                          sessionId: this.cmcd.sessionId,
                          contentId: this.cmcd.contentId,
                          useHeaders: false,
                      },
                  }
                : {}),
        });
        this.hls = hls;
        const E = Hls.Events;

        hls.on(E.MANIFEST_LOADED, (_e, data) => {
            const details = data.networkDetails as XMLHttpRequest | undefined;
            const text = typeof details?.responseText === 'string' ? details.responseText : null;
            if (text) this.media = parseUplynkMedia(text);
            this.request('manifest', 'master.m3u8', data.stats, 200);
            this.renditions = data.levels.map((_l, i) => this.toRendition(hls.levels[i], i));
            this.master = text;
        });
        hls.on(E.MANIFEST_PARSED, () => {
            this.renditions = hls.levels.map((l, i) => this.toRendition(l, i));
            const live = Boolean(hls.levels[0]?.details?.live ?? true);
            this.events.emit('manifest', {renditions: this.renditions, master: this.master, live});
        });
        hls.on(E.LEVEL_LOADED, (_e, data) => {
            const {details} = data;
            const ray = this.renditions[data.level]?.ray ?? null;
            this.request('playlist', `${ray ?? data.level}.m3u8`, data.stats, 200);
            const xhr = data.networkDetails as XMLHttpRequest | undefined;
            const first = details.fragments[0];
            const container = !first
                ? 'unknown'
                : details.fragments.some((f) => f.initSegment) ||
                    /\.(m4s|mp4|cmf[av]?)(\?|$)/i.test(first.url)
                  ? 'fMP4'
                  : /\.ts(\?|$)/i.test(first.url)
                    ? 'TS'
                    : 'unknown';
            this.events.emit('playlist', {
                ray,
                live: details.live,
                targetDuration: details.targetduration,
                windowSeconds: details.totalduration,
                segments: details.fragments.length,
                firstSn: details.startSN,
                lastSn: details.endSN,
                hasProgramDateTime: details.hasProgramDateTime,
                container,
                text: typeof xhr?.responseText === 'string' ? xhr.responseText : null,
            });
            for (const [id, range] of Object.entries(details.dateRanges)) {
                if (!range || this.dateRanges.has(id)) continue;
                this.dateRanges.add(id);
                const attr = range.attr as unknown as Record<string, string | undefined>;
                const which = ['SCTE35-OUT', 'SCTE35-IN', 'SCTE35-CMD'].find((k) => attr[k]);
                this.events.emit('daterange', {
                    id,
                    cls: range.class,
                    start: range.startDate,
                    duration: range.duration ?? range.plannedDuration,
                    scte35: which ? (attr[which] ?? null) : null,
                    attribute: which ?? null,
                });
            }
            if (data.level === 0 || this.liveKnown) return;
            this.liveKnown = true;
            this.events.emit('manifest', {
                renditions: this.renditions,
                master: this.master,
                live: data.details.live,
            });
        });
        hls.on(E.LEVEL_SWITCHED, (_e, data) => {
            const to = this.renditions[data.level];
            if (!to) return;
            this.events.emit('rendition', {from: this.current, to});
            this.current = to;
        });
        const emitAudio = () =>
            this.events.emit('audio', {
                tracks: hls.audioTracks.map((t) => ({
                    id: t.id,
                    name: t.name,
                    lang: t.lang ?? '',
                    isDefault: t.default,
                })),
                current: hls.audioTrack,
            });
        hls.on(E.AUDIO_TRACKS_UPDATED, emitAudio);
        hls.on(E.AUDIO_TRACK_SWITCHED, emitAudio);
        hls.on(E.FRAG_PARSING_METADATA, (_e, data) => {
            for (const sample of data.samples) {
                this.events.emit('id3', {
                    mediaTime: ptsToSeconds(sample.pts),
                    frames: parseId3(sample.data),
                });
            }
        });
        hls.on(E.KEY_LOADING, (_e, data) => {
            const uri = data.frag.decryptdata?.uri;
            if (uri) this.keyStarted.set(uri, performance.now());
        });
        hls.on(E.KEY_LOADED, (_e, data) => {
            const key = data.frag.decryptdata;
            if (!key?.uri) return;
            const started = this.keyStarted.get(key.uri);
            this.keyStarted.delete(key.uri);
            // Cached keys resolve in ~0 ms; only real fetches belong in the waterfall.
            if (started !== undefined && performance.now() - started > 3) {
                this.events.emit('request', {
                    kind: 'key',
                    name: 'key',
                    start: started,
                    end: performance.now(),
                    status: 200,
                    bytes: 16,
                    failed: false,
                });
            }
            this.events.emit('key', {
                uri: key.uri,
                method: key.method,
                ms: started === undefined ? null : Math.round(performance.now() - started),
            });
        });
        hls.on(E.FRAG_LOADED, (_e, data) => {
            const {frag} = data;
            const ray = this.renditions[frag.level]?.ray ?? null;
            const init = frag.sn === 'initSegment';
            this.request(
                init ? 'init' : 'segment',
                `${ray ?? frag.level} · ${init ? 'init' : `seg ${frag.sn}`}`,
                frag.stats,
                200,
            );
            if (init) return;
            const s = frag.stats.loading;
            this.events.emit('segment', {
                ray: this.renditions[frag.level]?.ray ?? null,
                sn: frag.sn,
                ms: Math.max(0, Math.round(s.end - s.start)),
                bytes: frag.stats.total || frag.stats.loaded,
            });
        });
        hls.on(E.FRAG_CHANGED, (_e, data) => {
            const cc = data.frag.cc;
            if (this.lastCc !== null && cc !== this.lastCc) this.events.emit('discontinuity', {cc});
            this.lastCc = cc;
            const asset = uplynkSegment(data.frag);
            if (asset && `${asset.assetId},${asset.kind}` !== this.asset) {
                this.asset = `${asset.assetId},${asset.kind}`;
                this.events.emit('asset', asset);
            }
        });
        hls.on(E.ERROR, (_e, data) => {
            const response = data.response as {code?: number} | undefined;
            const status = typeof response?.code === 'number' ? response.code : null;
            if (data.frag && status !== null && status >= 400) {
                const now = performance.now();
                const started = data.frag.stats.loading.start || now;
                this.events.emit('request', {
                    kind: 'segment',
                    name: `${this.renditions[data.frag.level]?.ray ?? data.frag.level} · seg ${data.frag.sn}`,
                    start: started,
                    end: now,
                    status,
                    bytes: 0,
                    failed: true,
                });
            }
            this.events.emit('error', {
                fatal: data.fatal,
                details: String(data.details),
                status: typeof response?.code === 'number' ? response.code : null,
                url: data.frag?.url ?? data.url ?? null,
            });
            if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        });

        hls.attachMedia(video);
        hls.loadSource(url);
    }

    private request(kind: RequestKind, name: string, stats: LoaderStats, status: number): void {
        const {start, end} = stats.loading;
        if (!start || !end) return;
        this.events.emit('request', {
            kind,
            name,
            start,
            end,
            status,
            bytes: stats.total || stats.loaded,
            failed: false,
        });
    }

    private master: string | null = null;
    private liveKnown = false;
    private current: Rendition | null = null;

    private toRendition(level: Level | undefined, index: number): Rendition {
        const uri = level ? (level.uri ?? level.url?.[0] ?? '') : '';
        const ray = rayFromUri(uri);
        const media = ray ? this.media.get(ray) : undefined;
        return {
            index,
            ray,
            width: level?.width || media?.width || 0,
            height: level?.height || media?.height || 0,
            bitrate: level?.bitrate ?? 0,
            codecs: level?.codecs ?? '',
            fps: media?.fps ?? (level?.frameRate || null),
            profile: media?.profile ?? videoProfile(level?.videoCodec),
        };
    }

    liveEdgeDrift(): number | null {
        const hls = this.hls;
        if (!hls?.levels[hls.currentLevel]?.details?.live) return null;
        const latency = hls.latency;
        return Number.isFinite(latency) ? latency : null;
    }

    targetLatency(): number | null {
        return this.hls?.targetLatency ?? null;
    }

    playingDate(): Date | null {
        return this.hls?.playingDate ?? null;
    }

    bandwidthEstimate(): number | null {
        const bwe = this.hls?.bandwidthEstimate;
        return bwe && Number.isFinite(bwe) ? bwe : null;
    }

    currentRendition(): Rendition | null {
        const level = this.hls?.currentLevel ?? -1;
        return this.renditions[level] ?? this.current;
    }

    jumpToLive(): void {
        const hls = this.hls;
        const media = hls?.media;
        if (!hls || !media) return;
        const target = hls.liveSyncPosition;
        if (target !== null && Number.isFinite(target)) media.currentTime = target;
    }

    drmState(): null {
        return null; // FairPlay (Safari) arrives in a later release
    }

    setAudioTrack(id: number): void {
        if (this.hls) this.hls.audioTrack = id;
    }

    async destroy(): Promise<void> {
        this.hls?.destroy();
        this.hls = null;
        this.events.clear();
    }
}

/** #UPLYNK-SEGMENT: <asset id>,<segment number>,<kind> from a fragment's tags. */
export function uplynkSegment(
    frag: Pick<Fragment, 'tagList'>,
): {assetId: string; kind: string} | null {
    for (const entry of frag.tagList ?? []) {
        const joined = entry.join(':');
        const match = /UPLYNK-SEGMENT:?\s*([^,\s]+),[^,]*,\s*([\w-]+)/i.exec(joined);
        if (match) return {assetId: match[1] as string, kind: (match[2] as string).toLowerCase()};
    }
    return null;
}
