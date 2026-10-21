// Calls to the harness backend. Signing happens server-side; the browser
// never sees an Uplynk API key.

import type {Preset} from './config';
import type {ServerClock} from './lib/clock';
import type {SlicerSettings} from './lib/slicer';

export interface Probe {
    ok: boolean;
    status: number | null;
    error: string | null;
    elapsed_ms: number;
    /** HLS only: how the first media playlist is protected. */
    encryption?: string | null;
}

export interface PlaybackResponse {
    url: string;
    expires_at: string;
    mode: 'url' | 'preplay';
    manifest: 'm3u8' | 'mpd';
    probe?: Probe;
    prefix?: string | null;
    drm_config?: {
        required?: boolean;
        widevineLicenseURL?: string;
        playreadyLicenseURL?: string;
        fairplayCertificateURL?: string;
    } | null;
    /** Live DASH: how far the MPD's clock runs ahead of the encoder's. */
    clock?: ServerClock | null;
    /** Preplay mode: the signed request sent to Uplynk (to share; never stored). */
    preplay_request?: string;
}

/** A failed sign/Preplay; `preplayRequest` is the signed Preplay URL that failed. */
export class PlaybackRequestError extends Error {
    constructor(
        message: string,
        readonly preplayRequest: string | null,
    ) {
        super(message);
    }
}

export interface PlaybackRequest {
    channel_id: number;
    manifest: 'm3u8' | 'mpd';
    params?: Record<string, string>;
    mode?: 'url' | 'preplay';
    drm?: 'wv' | 'pr' | 'fps';
}

export interface EngineVersion {
    version: string;
    released: string | null;
    notes_url: string;
}

const csrf = () =>
    document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';

export async function requestPlayback(
    endpoint: string,
    body: PlaybackRequest,
): Promise<PlaybackResponse> {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrf()},
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok)
        throw new PlaybackRequestError(
            data.error ?? `HTTP ${response.status}`,
            data.preplay_request ?? null,
        );
    return data as PlaybackResponse;
}

export interface SavedSession {
    id: string;
    url: string;
    size_kb: number;
    retention_days: number;
}

/** Store a recording; the server redacts it again and answers with its replay link. */
export async function saveRecording(endpoint: string, recording: unknown): Promise<SavedSession> {
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrf()},
        body: JSON.stringify(recording),
    });
    const data = await response.json().catch(() => ({error: `HTTP ${response.status}`}));
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data as SavedSession;
}

export async function fetchVersions(endpoint: string): Promise<EngineVersion[]> {
    const response = await fetch(endpoint);
    const data = await response.json().catch(() => ({versions: []}));
    return (data.versions ?? []) as EngineVersion[];
}

/** The channel's slicer settings, via the server's csl-slicer-console lookup. */
export async function fetchSlicer(endpoint: string): Promise<SlicerSettings> {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`slicer lookup answered ${response.status}`);
    return (await response.json()) as SlicerSettings;
}

async function presetCall(
    url: string,
    init: RequestInit,
): Promise<{items: Preset[]; preset?: Preset}> {
    const response = await fetch(url, {
        ...init,
        headers: {'Content-Type': 'application/json', 'X-CSRFToken': csrf()},
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error ?? `preset request answered ${response.status}`);
    return data;
}

/** Save a preset; the same name replaces the earlier one. */
export function savePreset(endpoint: string, name: string, query: string) {
    return presetCall(endpoint, {method: 'POST', body: JSON.stringify({name, query})});
}

export function deletePreset(endpoint: string, id: number) {
    return presetCall(`${endpoint}/${id}`, {method: 'DELETE'});
}

export async function fetchPresets(endpoint: string): Promise<Preset[]> {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`presets answered ${response.status}`);
    return ((await response.json()) as {items: Preset[]}).items;
}
