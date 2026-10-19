// CMCD (CTA-5004): the player tells the CDN what it's doing on every
// request, e.g. `CMCD=bl=21300,br=5694,ot=v,sf=h,sid="…"`, so CDN logs can
// be joined to a playback session by `sid`.
//
// Query mode only: Uplynk tolerates the extra `CMCD=` param on signed
// playlists, MPDs and segments, but its hosts don't allow CMCD headers in
// CORS preflights (the CDN answers 403), so header mode can't play.

export interface CmcdConfig {
    sessionId: string;
    contentId: string;
}

/** Key → value from a request URL's `CMCD=` param, or null if it has none. */
export function cmcdFromUrl(url: string): Record<string, string> | null {
    let raw: string | null;
    try {
        raw = new URL(url, 'https://x.invalid').searchParams.get('CMCD');
    } catch {
        return null;
    }
    if (raw === null) return null;
    const out: Record<string, string> = {};
    // Values are numbers, tokens or quoted strings that may contain commas.
    for (const m of raw.matchAll(/([a-z-]+)(?:=("(?:[^"\\]|\\.)*"|[^,]*))?/gi)) {
        const [, key, value] = m;
        if (key) out[key] = value === undefined ? 'true' : value.replace(/^"|"$/g, '');
    }
    return out;
}

/** Short, readable form for the Network tab: object type and the numbers. */
export function describeCmcd(keys: Record<string, string>): string {
    const OBJECT: Record<string, string> = {
        m: 'manifest',
        a: 'audio',
        v: 'video',
        av: 'muxed',
        i: 'init',
        c: 'captions',
        k: 'key',
        o: 'other',
    };
    const parts: string[] = [];
    const ot = keys.ot;
    if (ot) parts.push(OBJECT[ot] ?? ot);
    for (const [key, label, unit] of [
        ['br', 'br', ' kbps'],
        ['bl', 'buffer', ' ms'],
        ['mtp', 'throughput', ' kbps'],
        ['d', 'dur', ' ms'],
        ['dl', 'deadline', ' ms'],
        ['rtp', 'rtp', ' kbps'],
        ['tb', 'top', ' kbps'],
    ] as const) {
        if (keys[key] !== undefined) parts.push(`${label} ${keys[key]}${unit}`);
    }
    for (const flag of ['su', 'bs']) if (keys[flag]) parts.push(flag);
    return parts.join(' · ') || Object.keys(keys).join(',');
}

/** A fresh session id (a UUID where the browser has one). */
export function newSessionId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return Array.from({length: 4}, () => Math.random().toString(16).slice(2, 10)).join('-');
}

/** Content id: the Uplynk channel id, or the manifest's file name for a pasted URL. */
export function contentIdFor(channelId: string | null, url: string): string {
    if (channelId) return channelId;
    try {
        const name = new URL(url).pathname.split('/').pop() ?? '';
        return name.replace(/\.(m3u8|mpd|json)$/i, '') || 'unknown';
    } catch {
        return 'unknown';
    }
}
