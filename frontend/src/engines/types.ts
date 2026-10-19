// What the UI needs from a player engine: hls.js, Shaka, dash.js and native
// (<video src>) each implement it.

import type {CmcdConfig} from '../lib/cmcd';
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

export interface AudioTrack {
    id: number;
    name: string;
    lang: string;
    isDefault: boolean;
}

export type RequestKind = 'manifest' | 'playlist' | 'init' | 'segment' | 'key' | 'license';

export interface RequestTiming {
    kind: RequestKind;
    name: string;
    /** performance.now() milliseconds */
    start: number;
    end: number;
    status: number | null;
    bytes: number;
    failed: boolean;
    /** Full request URL, signatures included: redact before showing or storing. */
    url?: string;
    /** performance.now() when the first byte arrived, where the engine (or Resource Timing) says. */
    ttfb?: number | null;
    /** Media seconds in a segment, where known. */
    mediaDuration?: number | null;
    /** Network protocol from Resource Timing (h2, h3…), where the browser shares it. */
    protocol?: string | null;
}

export interface MediaPlaylistInfo {
    format?: 'hls' | 'dash';
    ray: string | null;
    live: boolean;
    targetDuration: number;
    windowSeconds: number;
    segments: number;
    firstSn: number;
    lastSn: number;
    hasProgramDateTime: boolean;
    container: 'TS' | 'fMP4' | 'unknown';
    /** Raw text when the engine exposes it (signatures still present). */
    text: string | null;
    /** DASH-only facts from the MPD root and Periods. */
    dash?: {
        updatePeriod: number | null;
        availabilityStart: string | null;
        periods: number;
        adPeriods: number;
        profiles: string | null;
    };
}

/** Widevine/PlayReady over DASH (Shaka, dash.js). */
export interface CencDrmConfig {
    keySystem: 'com.widevine.alpha' | 'com.microsoft.playready';
    licenseUrl: string;
}

/** FairPlay over HLS (Native, Safari). The license URL comes from each skd:// key URI. */
export interface FairPlayConfig {
    keySystem: 'com.apple.fps';
    certificateUrl: string;
}

export type DrmConfig = CencDrmConfig | FairPlayConfig;

export interface DrmState {
    keySystem: string | null;
    licenseServer: string | null;
    videoRobustness: string | null;
    audioRobustness: string | null;
    encryptionScheme: string | null;
    /** key id (hex) → MediaKeyStatus, e.g. usable, output-restricted, expired */
    keyStatuses: Record<string, string>;
    /** Seconds spent on license requests (engine's own count). */
    licenseSeconds: number | null;
    expiration: number | null;
}

export interface EngineEvents {
    manifest: {renditions: Rendition[]; master: string | null; live: boolean};
    rendition: {from: Rendition | null; to: Rendition};
    id3: {mediaTime: number; frames: Id3Frame[]};
    key: {uri: string; method: string; ms: number | null};
    segment: {ray: string | null; sn: number | string; ms: number; bytes: number};
    discontinuity: {cc: number};
    error: {fatal: boolean; details: string; status: number | null; url: string | null};
    audio: {tracks: AudioTrack[]; current: number};
    request: RequestTiming;
    playlist: MediaPlaylistInfo;
    /** The playhead entered a new Uplynk asset (#UPLYNK-SEGMENT: id,num,kind). */
    asset: {assetId: string; kind: string};
    /** A DRM license request finished (or failed). */
    license: {
        ms: number;
        status: number | null;
        bytes: number;
        failed: boolean;
        error: string | null;
    };
    keystatus: {statuses: Record<string, string>};
    /** DASH in-band event (emsg) the UI doesn't otherwise understand. */
    emsg: {scheme: string; value: string; bytes: number};
    /** #EXT-X-DATERANGE, once per id; scte35 is the hex payload if any. */
    daterange: {
        id: string;
        cls: string;
        start: Date;
        duration: number | null;
        scte35: string | null;
        attribute: string | null;
    };
}

export type EngineEventName = keyof EngineEvents;
export type Listener<K extends EngineEventName> = (data: EngineEvents[K]) => void;

export interface PlayerEngine {
    readonly name: string;
    readonly version: string;
    /** What this engine can't report, said once in the log and empty panels. */
    readonly limits?: string;
    /** Send CMCD (query mode) with every request; set before load(). Native ignores it. */
    cmcd?: CmcdConfig | null;
    load(url: string, video: HTMLVideoElement): void;
    /** Resolves once the video element is free for the next engine. */
    destroy(): Promise<void>;
    on<K extends EngineEventName>(event: K, listener: Listener<K>): void;
    /** Seconds between the playhead and the live edge, or null when not live. */
    liveEdgeDrift(): number | null;
    targetLatency(): number | null;
    /** Program date-time at the playhead (from #EXT-X-PROGRAM-DATE-TIME). */
    playingDate(): Date | null;
    bandwidthEstimate(): number | null;
    currentRendition(): Rendition | null;
    jumpToLive(): void;
    setAudioTrack(id: number): void;
    /** DRM details, or null for clear/AES-128 playback. */
    drmState(): DrmState | null;
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
