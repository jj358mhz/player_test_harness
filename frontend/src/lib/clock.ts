// Which clock a latency number is measured against.
//
// Uplynk's default program dates are per session: the first slice a session
// sees is stamped "now", so they ignore the delay before it and drift when a
// session idles. `pdts=latency` stamps slices with encoder time instead.
// DASH has no such option: the MPD's clock puts the newest segment at about
// now, so the server measures how far it runs ahead (`clock.offset_s`, from
// matching slices against pdts=latency HLS) and we add that back.

export type ClockKind = 'encoder' | 'session' | 'mpd-offset' | 'mpd';

export interface ServerClock {
    offset_s: number;
    edge_age_s: number | null;
    reference: string;
    slice: string;
}

export interface ClockInfo {
    kind: ClockKind;
    /** Seconds to add to MPD-clock latency (mpd-offset only). */
    offsetS: number | null;
    /** Real age of the MPD's newest segment when the server fetched it. */
    edgeAgeS: number | null;
    slice: string | null;
    /** Uplynk `delay` signed into the URL; null = the channel's default. */
    delay: number | null;
}

export const CLOCK_LABELS: Record<ClockKind, {name: string; what: string}> = {
    encoder: {
        name: 'Encoder clock',
        what: 'Signed with pdts=latency: program dates are encoder time',
    },
    session: {
        name: 'Session clock',
        what: "Uplynk's default program dates start at the session's first slice; they miss the delay before it and drift if the session idles. Sign with pdts=latency for real latency",
    },
    'mpd-offset': {
        name: 'MPD clock + offset',
        what: "The MPD's clock puts its newest segment at now; the offset was measured at load against pdts=latency HLS",
    },
    mpd: {
        name: 'MPD clock',
        what: "The MPD's clock puts its newest segment at now, so this under-reads by the edge's real age (about 30 s by default)",
    },
};

/** `delay=` choices in the load bar, seconds. */
export const DELAY_CHOICES = [15, 20, 30, 45, 60, 90, 120];

/** A whole number of seconds Uplynk would accept as `delay`, or null. */
export function parseDelay(value: string | null | undefined): number | null {
    if (!value || !/^\d{1,3}$/.test(value)) return null;
    const n = Number(value);
    return n <= 600 ? n : null;
}

function param(url: string, name: string): string | null {
    try {
        return new URL(url).searchParams.get(name);
    } catch {
        return null;
    }
}

export function clockFor(
    format: 'm3u8' | 'mpd',
    url: string,
    server: ServerClock | null | undefined,
    delay: number | null = parseDelay(param(url, 'delay')),
    // Preplay session URLs (/preplay2/…) don't repeat the signed params: pass pdts.
    pdts: string | null = param(url, 'pdts'),
): ClockInfo {
    const base = {offsetS: null, edgeAgeS: null, slice: null, delay};
    if (format === 'mpd') {
        return server
            ? {
                  ...base,
                  kind: 'mpd-offset',
                  offsetS: server.offset_s,
                  edgeAgeS: server.edge_age_s,
                  slice: server.slice,
              }
            : {...base, kind: 'mpd'};
    }
    return {...base, kind: pdts === 'latency' ? 'encoder' : 'session'};
}

/** Where the master asks players to start: EXT-X-START, described. */
export function hlsStart(master: string | null): string | null {
    const match = master?.match(/^#EXT-X-START:(.*)$/m);
    if (!match) return null;
    const offset = Number(match[1]?.match(/TIME-OFFSET=(-?[\d.]+)/)?.[1]);
    if (!Number.isFinite(offset)) return match[1] ?? null;
    if (offset === 0) return 'TIME-OFFSET=0: the oldest segment, a whole window behind the edge';
    return offset < 0
        ? `TIME-OFFSET=${offset}: ${-offset} s before the live edge`
        : `TIME-OFFSET=${offset}: ${offset} s after the oldest segment`;
}
