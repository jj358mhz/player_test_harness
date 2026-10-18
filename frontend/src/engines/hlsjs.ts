// hls.js adapter. The library itself is loaded at runtime from jsDelivr so
// any version can be picked; the npm dependency supplies types and the
// default version (bumped by Dependabot).

import type HlsType from 'hls.js';
import type {Level} from 'hls.js';
import {version as pinned} from 'hls.js/package.json';
import {parseId3} from '../lib/id3';
import {ptsToSeconds} from '../lib/latency';
import {parseUplynkMedia, rayFromUri, type UplynkMedia} from '../lib/rays';
import {Emitter, type Listener, type PlayerEngine, type Rendition} from './types';

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
    readonly name = 'hls.js';
    private hls: HlsType | null = null;
    private events = new Emitter();
    private renditions: Rendition[] = [];
    private media = new Map<string, UplynkMedia>();
    private lastCc: number | null = null;
    private keyStarted = new Map<string, number>();

    constructor(
        private Hls: HlsClass,
        readonly version: string,
    ) {}

    on<K extends Parameters<PlayerEngine['on']>[0]>(event: K, listener: Listener<K>): void {
        this.events.on(event, listener);
    }

    load(url: string, video: HTMLVideoElement): void {
        const {Hls} = this;
        const hls = new Hls({enableWorker: true, lowLatencyMode: true});
        this.hls = hls;
        const E = Hls.Events;

        hls.on(E.MANIFEST_LOADED, (_e, data) => {
            const details = data.networkDetails as XMLHttpRequest | undefined;
            const text = typeof details?.responseText === 'string' ? details.responseText : null;
            if (text) this.media = parseUplynkMedia(text);
            this.renditions = data.levels.map((_l, i) => this.toRendition(hls.levels[i], i));
            this.master = text;
        });
        hls.on(E.MANIFEST_PARSED, () => {
            this.renditions = hls.levels.map((l, i) => this.toRendition(l, i));
            const live = Boolean(hls.levels[0]?.details?.live ?? true);
            this.events.emit('manifest', {renditions: this.renditions, master: this.master, live});
        });
        hls.on(E.LEVEL_LOADED, (_e, data) => {
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
            this.events.emit('key', {
                uri: key.uri,
                method: key.method,
                ms: started === undefined ? null : Math.round(performance.now() - started),
            });
        });
        hls.on(E.FRAG_LOADED, (_e, data) => {
            const {frag} = data;
            if (frag.sn === 'initSegment') return;
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
        });
        hls.on(E.ERROR, (_e, data) => {
            const response = data.response as {code?: number} | undefined;
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
            profile: media?.profile ?? null,
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

    destroy(): void {
        this.hls?.destroy();
        this.hls = null;
        this.events.clear();
    }
}
