// Side-by-side compare: two players, each in its own iframe (engines load
// globals such as window.shaka, so two versions can't share a page). The
// compare page links both views as `?a=<player query>&b=<player query>` and
// reads each pane's numbers through PlayerApp.snapshot().

import {parseView, type View, viewQuery} from './deeplink';

export interface StatLine {
    last: number | null;
    avg: number | null;
    min: number | null;
    max: number | null;
    count: number;
}

/** What one pane reports to the compare page, once a second. */
export interface PaneSnapshot {
    title: string | null;
    engine: string;
    version: string;
    format: 'm3u8' | 'mpd';
    drm: string | null;
    clock: string | null;
    delay: number | null;
    live: boolean;
    playing: boolean;
    latencyName: string;
    latency: StatLine;
    drift: number | null;
    buffer: number | null;
    ray: string | null;
    height: number | null;
    bitrate: number | null;
    bandwidth: number | null;
    /** Load to first frame, milliseconds. */
    startupMs: number | null;
    rebuffers: number;
    stalledS: number;
    errors: number;
    switches: number;
    segmentAvgMs: number | null;
    /** Headline latency, last five minutes (epoch ms). */
    series: {t: number; v: number}[];
}

export type Preset = 'hls-dash' | 'hlsjs-shaka' | 'shaka-dashjs' | 'delay';

export const PRESETS: Record<Preset, {label: string; a: View; b: View}> = {
    'hls-dash': {
        label: 'HLS vs DASH (hls.js | Shaka)',
        a: {engine: 'hls.js'},
        b: {format: 'mpd', engine: 'shaka-player'},
    },
    'hlsjs-shaka': {
        label: 'hls.js vs Shaka (HLS)',
        a: {engine: 'hls.js'},
        b: {engine: 'shaka-player'},
    },
    'shaka-dashjs': {
        label: 'Shaka vs dash.js (DASH)',
        a: {format: 'mpd', engine: 'shaka-player'},
        b: {format: 'mpd', engine: 'dashjs'},
    },
    delay: {
        label: 'Default vs 20 s delay (hls.js)',
        a: {engine: 'hls.js'},
        b: {engine: 'hls.js', delay: 20},
    },
};

/** Player queries for a preset on one channel. */
export function presetQueries(preset: Preset, channel: number): {a: string; b: string} {
    const p = PRESETS[preset];
    return {a: viewQuery({...p.a, channel}), b: viewQuery({...p.b, channel})};
}

/** The compare page's own query, from both panes' player queries. */
export function compareSearch(a: string, b: string): string {
    const q = new URLSearchParams();
    q.set('a', a.replace(/^\?/, ''));
    q.set('b', b.replace(/^\?/, ''));
    return q.toString();
}

/**
 * The two panes' player queries from the compare page's query. Each is run
 * through the player's own deep-link parser, so only known, checked values
 * reach the iframes.
 */
export function parseCompare(search: string): {a: string | null; b: string | null} {
    const q = new URLSearchParams(search);
    const pane = (key: string) => {
        const raw = q.get(key);
        if (!raw) return null;
        const query = viewQuery(parseView(raw));
        return query || null;
    };
    return {a: pane('a'), b: pane('b')};
}

/** B − A, or null if either is missing. */
export function delta(a: number | null | undefined, b: number | null | undefined): number | null {
    return a === null || a === undefined || b === null || b === undefined ? null : b - a;
}
