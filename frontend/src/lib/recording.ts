// A recorded session: everything one load measured, as plain JSON, for the
// server to keep and /sessions/<id> to replay. Built in the browser, so it
// is redacted here (and again on the server): no signatures, no session
// tokens, no license URL queries.

import type {Point} from './stats';

export const RECORDING_VERSION = 1;

/** Caps per list, so a long session stays well under the upload limit. */
export const LIMITS = {points: 21600, events: 5000, log: 3000, requests: 400, breaks: 500};

export interface StatsSummary {
    count: number;
    last: number | null;
    avg: number | null;
    min: number | null;
    max: number | null;
}

export interface RequestKindStats {
    count: number;
    failed: number;
    avgMs: number | null;
    p95Ms: number | null;
    bytes: number;
}

export interface Recording {
    v: number;
    title: string;
    source: {
        channel: number | null;
        /** Signed URL with sig/pbs redacted. */
        url: string;
        format: 'm3u8' | 'mpd';
        engine: string;
        version: string;
        drm: string | null;
        /** Deep-link query that reopens this view live. */
        link: string;
    };
    startedAt: number;
    endedAt: number;
    live: boolean;
    userAgent: string;
    latencyName: string;
    stats: {latency: StatsSummary; id3: StatsSummary; pdt: StatsSummary; drift: StatsSummary};
    counters: Record<string, number | null>;
    series: {latency: Point[]; drift: Point[]};
    events: {t: number; kind: string; label: string}[];
    breaks: {start: number; end: number | null; planned: number | null; label: string}[];
    log: {t: number; kind: string; label: string; text: string}[];
    renditions: {
        ray: string | null;
        width: number;
        height: number;
        bitrate: number;
        codecs: string;
        fps: number | null;
        profile: string | null;
    }[];
    requestStats: Record<string, RequestKindStats>;
    /** The last requests, epoch milliseconds. */
    requests: {
        kind: string;
        name: string;
        start: number;
        end: number;
        status: number | null;
        bytes: number;
        failed: boolean;
    }[];
    drm: {
        keySystem: string | null;
        licenseServer: string | null;
        robustness: string | null;
        keyStatuses: Record<string, string>;
    } | null;
    playlist: Record<string, unknown> | null;
}

/** Push and drop the oldest entries past `cap`. */
export function capPush<T>(list: T[], item: T, cap: number): void {
    list.push(item);
    if (list.length > cap) list.splice(0, list.length - cap);
}

const TOKEN_RE = /([?&](?:amp;)?(?:sig|pbs)=)[^&\s"<]+/g;
/** The same inside a percent-encoded URL, e.g. a `src=` deep link. */
const ENCODED_TOKEN_RE = /((?:%3F|%26)(?:sig|pbs)%3D)[^&%\s"<]+/gi;

/** Preplay play URLs carry the session in the path: /preplay2/channel/<id>/<sid>/<token>.mpd */
const PREPLAY_PATH_RE = /(\/preplay2\/(?:channel\/|event\/)?[^/?#\s"<]+\/)[^?#\s"<]+/g;

export function redact(text: string): string {
    return text
        .replace(TOKEN_RE, '$1…')
        .replace(ENCODED_TOKEN_RE, '$1…')
        .replace(PREPLAY_PATH_RE, '$1…');
}

/** Origin and path only: license URLs carry session tokens in the query. */
export function stripQuery(url: string | null): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return redact(url.split('?')[0] ?? '');
    }
}

/** Every string in a JSON-like value, redacted. */
export function redactDeep<T>(value: T): T {
    if (typeof value === 'string') return redact(value) as T;
    if (Array.isArray(value)) return value.map(redactDeep) as T;
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
    }
    return value;
}

export function summarize(stats: {
    count: number;
    last: number | null;
    average: number | null;
    min: number;
    max: number;
}): StatsSummary {
    const finite = (v: number) => (Number.isFinite(v) ? v : null);
    return {
        count: stats.count,
        last: stats.last,
        avg: stats.average,
        min: stats.count ? finite(stats.min) : null,
        max: stats.count ? finite(stats.max) : null,
    };
}

/** Running per-kind request totals for the whole session (the list itself is capped). */
export class RequestTally {
    private kinds = new Map<string, {count: number; failed: number; ms: number[]; bytes: number}>();

    add(kind: string, ms: number, bytes: number, failed: boolean): void {
        const k = this.kinds.get(kind) ?? {count: 0, failed: 0, ms: [], bytes: 0};
        k.count += 1;
        if (failed) k.failed += 1;
        capPush(k.ms, ms, 5000);
        k.bytes += bytes;
        this.kinds.set(kind, k);
    }

    summary(): Record<string, RequestKindStats> {
        const out: Record<string, RequestKindStats> = {};
        for (const [kind, k] of this.kinds) {
            const sorted = [...k.ms].sort((a, b) => a - b);
            const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
            const p95 = sorted.length
                ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number)
                : null;
            out[kind] = {
                count: k.count,
                failed: k.failed,
                avgMs: avg === null ? null : Math.round(avg),
                p95Ms: p95 === null ? null : Math.round(p95),
                bytes: k.bytes,
            };
        }
        return out;
    }
}
