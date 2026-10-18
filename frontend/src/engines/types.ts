// What the UI needs from a player engine. hls.js implements it now; Shaka,
// dash.js and native playback implement it in Phase 2.

import type {Id3Frame} from '../lib/id3';

export interface Rendition {
    index: number;
    ray: string | null;
    width: number;
    height: number;
    bitrate: number; // bits per second
    codecs: string;
    fps: number | null;
    profile: string | null; // from #UPLYNK-MEDIA0, e.g. high-31
}

export interface EngineEvents {
    manifest: {renditions: Rendition[]; master: string | null; live: boolean};
    rendition: {from: Rendition | null; to: Rendition};
    id3: {mediaTime: number; frames: Id3Frame[]};
    key: {uri: string; method: string; ms: number | null};
    segment: {ray: string | null; sn: number | string; ms: number; bytes: number};
    discontinuity: {cc: number};
    error: {fatal: boolean; details: string; status: number | null; url: string | null};
}

export type EngineEventName = keyof EngineEvents;
export type Listener<K extends EngineEventName> = (data: EngineEvents[K]) => void;

export interface PlayerEngine {
    readonly name: string;
    readonly version: string;
    load(url: string, video: HTMLVideoElement): void;
    destroy(): void;
    on<K extends EngineEventName>(event: K, listener: Listener<K>): void;
    /** Seconds between the playhead and the live edge, or null when not live. */
    liveEdgeDrift(): number | null;
    targetLatency(): number | null;
    /** Program date-time at the playhead (from #EXT-X-PROGRAM-DATE-TIME). */
    playingDate(): Date | null;
    bandwidthEstimate(): number | null;
    currentRendition(): Rendition | null;
    jumpToLive(): void;
}

/** Tiny typed event emitter shared by engine adapters. */
export class Emitter {
    private listeners = new Map<EngineEventName, Set<(data: unknown) => void>>();

    on<K extends EngineEventName>(event: K, listener: Listener<K>): void {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener as (data: unknown) => void);
        this.listeners.set(event, set);
    }

    emit<K extends EngineEventName>(event: K, data: EngineEvents[K]): void {
        for (const listener of this.listeners.get(event) ?? []) listener(data);
    }

    clear(): void {
        this.listeners.clear();
    }
}
