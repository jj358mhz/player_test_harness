// Network tab waterfall: one request's detail, from what the engine reported
// plus Resource Timing.
//
// Uplynk's content and CDN hosts send no Timing-Allow-Origin, so the
// browser zeroes cross-origin timing detail (DNS, connect, first byte) and
// pages can't read X-Cache or Age (not in Access-Control-Expose-Headers).
// First byte comes from the engine where it measures it (hls.js, dash.js);
// Resource Timing fills in if a host ever allows it.

import type {RequestTiming} from '../engines/types';
import {cmcdFromUrl, describeCmcd} from './cmcd';
import {redact} from './recording';

/** Stable id for a request across redraws. */
export function requestKey(r: RequestTiming): string {
    return `${r.start.toFixed(1)}|${r.name}`;
}

/** Bar colour: failed, slow (a segment taking over half its duration), or its kind. */
export function requestState(r: RequestTiming, targetMs: number): string {
    if (r.failed) return 'err';
    const budget = (r.mediaDuration ? r.mediaDuration * 1000 : targetMs) * 0.5;
    return r.kind === 'segment' && r.end - r.start > budget ? 'slow' : r.kind;
}

/** First byte and protocol from a Resource Timing entry, when the host allows it. */
export function fromResourceTiming(
    r: RequestTiming,
    entry:
        | Pick<PerformanceResourceTiming, 'responseStart' | 'nextHopProtocol' | 'startTime'>
        | undefined,
): Pick<RequestTiming, 'ttfb' | 'protocol'> {
    if (!entry) return {};
    const out: Pick<RequestTiming, 'ttfb' | 'protocol'> = {};
    // Without Timing-Allow-Origin responseStart is 0.
    if (r.ttfb == null && entry.responseStart > 0 && entry.responseStart <= r.end + 5)
        out.ttfb = Math.max(entry.responseStart, r.start);
    if (entry.nextHopProtocol) out.protocol = entry.nextHopProtocol;
    return out;
}

const ms = (v: number) => `${Math.round(v).toLocaleString('en-US')} ms`;

export interface RequestDetail {
    title: string;
    rows: [string, string][];
    /** What isn't known and why. */
    notes: string[];
    /** Share of the bar spent waiting for the first byte (0–1), or null. */
    waitShare: number | null;
}

export function requestDetail(r: RequestTiming, engine: string): RequestDetail {
    const total = r.end - r.start;
    const rows: [string, string][] = [];
    const notes: string[] = [];
    let host = '';
    if (r.url) {
        try {
            host = new URL(r.url).host;
        } catch {
            host = '';
        }
        rows.push(['URL', redact(r.url)]);
    }
    if (host) rows.push(['Host', host]);
    rows.push([
        'Status',
        r.failed ? `failed${r.status ? ` (HTTP ${r.status})` : ''}` : String(r.status ?? '--'),
    ]);
    rows.push([
        'Size',
        `${(r.bytes / 1024).toLocaleString('en-US', {maximumFractionDigits: 1})} KB`,
    ]);
    rows.push(['Total', ms(total)]);
    let waitShare: number | null = null;
    if (r.ttfb != null && total > 0) {
        const wait = r.ttfb - r.start;
        const download = r.end - r.ttfb;
        waitShare = Math.min(1, Math.max(0, wait / total));
        rows.push(['First byte', `${ms(wait)} (request → first byte)`]);
        rows.push(['Download', ms(download)]);
        if (download > 0 && r.bytes)
            rows.push([
                'Throughput',
                `${((r.bytes * 8) / download / 1000).toFixed(1)} Mbps (download only)`,
            ]);
    } else {
        notes.push(
            `First byte: not reported by ${engine} for this request, and the host sends no Timing-Allow-Origin, so the browser hides it.`,
        );
        if (total > 0 && r.bytes)
            rows.push([
                'Throughput',
                `${((r.bytes * 8) / total / 1000).toFixed(1)} Mbps (whole request)`,
            ]);
    }
    if (r.mediaDuration) {
        const share = total / (r.mediaDuration * 1000);
        rows.push([
            'Media',
            `${r.mediaDuration.toFixed(3)} s · loaded in ${(share * 100).toFixed(0)}% of its duration`,
        ]);
    }
    if (r.protocol) rows.push(['Protocol', r.protocol]);
    const cmcd = r.url ? cmcdFromUrl(r.url) : null;
    if (cmcd) rows.push(['CMCD sent', describeCmcd(cmcd)]);
    notes.push(
        'Cache hit/miss: the CDN sends X-Cache and Age, but not in Access-Control-Expose-Headers, so pages can’t read them.',
    );
    return {title: `${r.kind} · ${r.name}`, rows, notes, waitShare};
}
