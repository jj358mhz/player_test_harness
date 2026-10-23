// SVG charts: the latency chart in the Latency tab and the event timeline
// under the video. Both share one time window.

import {BANDS} from '../lib/bands';
import type {Point} from '../lib/stats';
import {svg} from './dom';

const css = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Replays draw a fixed range ending at `end`, with clock-time labels. */
export interface ChartRange {
    end: number;
}

export function drawLatencyChart(
    el: SVGSVGElement,
    points: Point[],
    windowMs: number,
    range?: ChartRange,
): void {
    const {x, y} = latencyAxes(el, Math.max(15, ...points.map((p) => p.v)), windowMs, range);
    if (points.length < 2) return;
    const pts = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const first = points[0] as Point;
    const last = points[points.length - 1] as Point;
    svg(
        'polygon',
        {
            points: `${x(first.t)},${y(0)} ${pts} ${x(last.t)},${y(0)}`,
            fill: 'var(--accent)',
            'fill-opacity': 0.15,
        },
        el,
    );
    svg('polyline', {points: pts, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.75}, el);
    svg(
        'circle',
        {
            cx: x(last.t),
            cy: y(last.v),
            r: 3.5,
            fill: '#fff',
            stroke: 'var(--accent)',
            'stroke-width': 2,
        },
        el,
    );
}

/** Several latency lines on one set of axes (the compare page). */
export function drawLatencyLines(
    el: SVGSVGElement,
    lines: {points: Point[]; color: string}[],
    windowMs: number,
): void {
    const all = lines.flatMap((l) => l.points.map((p) => p.v));
    const {x, y} = latencyAxes(el, Math.max(15, ...all), windowMs);
    for (const {points, color} of lines) {
        if (points.length < 2) continue;
        const pts = points.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
        svg('polyline', {points: pts, fill: 'none', stroke: color, 'stroke-width': 1.75}, el);
        const last = points[points.length - 1] as Point;
        svg(
            'circle',
            {cx: x(last.t), cy: y(last.v), r: 3.5, fill: '#fff', stroke: color, 'stroke-width': 2},
            el,
        );
    }
}

/** Clear `el`, draw bands, grid and time labels; returns the scales. */
function latencyAxes(
    el: SVGSVGElement,
    peak: number,
    windowMs: number,
    range?: ChartRange,
): {x: (t: number) => number; y: (v: number) => number} {
    el.textContent = '';
    const W = 560;
    const H = 160;
    const L = 34;
    const R = 8;
    const T = 8;
    const B = 20;
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const maxV = peak * 1.1;
    const step = niceStep(maxV / 5); // about five grid lines whatever the range
    const top = Math.ceil(maxV / step) * step;
    const now = range?.end ?? Date.now();
    const x = (t: number) => L + (1 - (now - t) / windowMs) * (W - L - R);
    const y = (v: number) => T + (1 - v / top) * (H - T - B);

    let lower = 0;
    for (const band of BANDS) {
        const upper = Math.min(band.below, top);
        if (lower >= top) break;
        svg(
            'rect',
            {
                x: L,
                y: y(upper),
                width: W - L - R,
                height: y(lower) - y(upper),
                fill: `var(--band-${band.key})`,
                'fill-opacity': 0.07,
            },
            el,
        );
        lower = upper;
    }
    for (let v = 0; v <= top; v += step) {
        svg('line', {x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: css('--border-strong')}, el);
        svg(
            'text',
            {x: L - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'chart-label'},
            el,
        ).textContent = `${v}s`;
    }
    const minutes = Math.round(windowMs / 60000);
    const labels: [string, number, string][] = range
        ? [
              [clockLabel(now - windowMs), now - windowMs, 'start'],
              [clockLabel(now - windowMs / 2), now - windowMs / 2, 'middle'],
              [clockLabel(now), now, 'end'],
          ]
        : [
              [`-${minutes}m`, now - windowMs, 'start'],
              [`-${minutes / 2}m`, now - windowMs / 2, 'middle'],
              ['now', now, 'end'],
          ];
    for (const [label, t, anchor] of labels) {
        svg(
            'text',
            {x: x(t), y: H - 5, 'text-anchor': anchor, class: 'chart-label'},
            el,
        ).textContent = label;
    }
    return {x, y};
}

export type TimelineKind = 'abr' | 'key' | 'scte' | 'disc' | 'err';

export interface TimelineEvent {
    t: number;
    kind: TimelineKind;
    label: string;
}

export interface AdBreak {
    start: number; // ms since epoch
    end: number | null;
    planned: number | null; // seconds
    label: string;
}

export interface TimelineSeries {
    latency: Point[];
    latencyLabel: string; // e.g. "Latency (PDT)"
    drift: Point[];
}

/**
 * Last-N-minutes strip: latency and live-edge drift on one seconds scale
 * (so you can see latency grow as the player drifts), time ticks, and an
 * event lane underneath. Drawn in real pixels (viewBox = element size) so
 * labels aren't stretched.
 */
export function drawTimeline(
    el: SVGSVGElement,
    series: TimelineSeries,
    events: TimelineEvent[],
    breaks: AdBreak[],
    windowMs: number,
    range?: ChartRange,
): void {
    el.textContent = '';
    const W = Math.max(320, Math.round(el.clientWidth || 800));
    const H = 132;
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.removeAttribute('preserveAspectRatio');
    const L = 52; // y labels and the "events" lane label
    const R = 64; // current-value labels
    const top = 8;
    const plotBottom = 78;
    const laneTop = 102;
    const laneBottom = 124;
    const now = range?.end ?? Date.now();
    const x = (t: number) => L + (1 - (now - t) / windowMs) * (W - L - R);

    // Ad breaks span the whole strip
    for (const b of breaks) {
        const x1 = Math.max(L, x(b.start));
        const x2 = Math.min(W - R, x(b.end ?? now));
        if (x2 <= L) continue;
        const rect = svg(
            'rect',
            {
                x: x1,
                y: 0,
                width: Math.max(2, x2 - x1),
                height: laneBottom,
                fill: 'var(--scte)',
                'fill-opacity': 0.12,
            },
            el,
        );
        svg('title', {}, rect).textContent = `Ad break · ${b.label}`;
        if (x2 - x1 > 70) {
            const seconds = Math.round(((b.end ?? now) - b.start) / 1000);
            svg(
                'text',
                {x: x1 + 6, y: top + 10, class: 'chart-label chart-label--scte'},
                el,
            ).textContent =
                `Ad break · ${seconds}${b.planned ? ` of ${Math.round(b.planned)}` : ''} s`;
        }
    }

    // Shared seconds scale from 0, about three grid lines
    const values = [...series.latency, ...series.drift].map((p) => p.v);
    const maxV = Math.max(10, ...values) * 1.1;
    const step = niceStep(maxV / 3);
    const topV = Math.ceil(maxV / step) * step;
    const y = (v: number) => top + (1 - v / topV) * (plotBottom - top);
    for (let v = 0; v <= topV; v += step) {
        svg('line', {x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: css('--border')}, el);
        svg(
            'text',
            {x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'chart-label'},
            el,
        ).textContent = `${v}s`;
    }

    // Time ticks: every minute live; spaced to about eight ticks on a replay
    const minutes = Math.round(windowMs / 60000);
    const every = range ? tickMinutes(windowMs / 60000) : 1;
    for (let m = Math.floor(minutes / every) * every; m >= 0; m -= every) {
        const tx = x(now - m * 60000);
        svg(
            'line',
            {x1: tx, x2: tx, y1: plotBottom, y2: plotBottom + 4, stroke: css('--border-strong')},
            el,
        );
        svg(
            'text',
            {
                x: tx,
                y: plotBottom + 15,
                'text-anchor': m === minutes ? 'start' : m === 0 ? 'end' : 'middle',
                class: 'chart-label',
            },
            el,
        ).textContent = range ? clockLabel(now - m * 60000) : m === 0 ? 'now' : `-${m}m`;
    }

    // Lines + current values at the right edge
    const labels: {y: number; text: string; color: string}[] = [];
    const line = (points: Point[], color: string, dash: string | null, name: string) => {
        if (!points.length) return;
        const visible = points.filter((p) => now - p.t <= windowMs);
        if (visible.length > 1) {
            svg(
                'polyline',
                {
                    points: visible
                        .map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
                        .join(' '),
                    fill: 'none',
                    stroke: color,
                    'stroke-width': 1.75,
                    'stroke-linejoin': 'round',
                    ...(dash ? {'stroke-dasharray': dash} : {}),
                },
                el,
            );
        }
        const last = points[points.length - 1] as Point;
        svg('circle', {cx: x(last.t), cy: y(last.v), r: 3, fill: color}, el);
        labels.push({y: y(last.v), text: `${last.v.toFixed(1)} s`, color});
        svg('title', {}, el).textContent = name;
    };
    line(series.latency, 'var(--accent)', null, series.latencyLabel);
    line(series.drift, 'var(--drift)', '5 3', 'Live-edge drift');
    // keep the two value labels from overlapping
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
        const prev = labels[i - 1] as (typeof labels)[number];
        const cur = labels[i] as (typeof labels)[number];
        if (cur.y - prev.y < 12) cur.y = prev.y + 12;
    }
    for (const lab of labels) {
        svg(
            'text',
            {x: W - R + 8, y: lab.y + 4, class: 'chart-value', fill: lab.color},
            el,
        ).textContent = lab.text;
    }

    // Event lane
    svg(
        'text',
        {x: L - 6, y: (laneTop + laneBottom) / 2 + 3.5, 'text-anchor': 'end', class: 'chart-label'},
        el,
    ).textContent = 'events';
    svg('line', {x1: L, x2: W - R, y1: laneBottom, y2: laneBottom, stroke: css('--border')}, el);
    const mid = (laneTop + laneBottom) / 2;
    for (const e of events) {
        const ex = x(e.t);
        if (ex < L) continue;
        let mark: SVGElement;
        if (e.kind === 'abr')
            mark = svg(
                'rect',
                {x: ex - 4, y: mid - 6, width: 8, height: 12, rx: 2, fill: 'var(--info)'},
                el,
            );
        else if (e.kind === 'key')
            mark = svg(
                'rect',
                {x: ex - 1, y: mid - 7, width: 2, height: 14, fill: 'var(--warn)'},
                el,
            );
        else if (e.kind === 'scte')
            mark = svg(
                'rect',
                {
                    x: ex - 2,
                    y: top,
                    width: 4,
                    height: laneBottom - top,
                    fill: 'var(--scte)',
                    'fill-opacity': 0.55,
                },
                el,
            );
        else if (e.kind === 'disc')
            mark = svg(
                'rect',
                {x: ex - 1, y: mid - 8, width: 2, height: 16, fill: 'var(--text-dim)'},
                el,
            );
        else mark = svg('circle', {cx: ex, cy: mid, r: 5, fill: 'var(--error)'}, el);
        svg('title', {}, mark).textContent = e.label;
    }
}

export interface Span {
    start: number; // ms since epoch
    end: number | null;
}

export interface BufferSeries {
    buffer: Point[]; // seconds of forward buffer
    bandwidth: Point[]; // the engine's ABR estimate, bits/s
    stalls: Span[];
}

/**
 * Forward buffer (filled, left scale in seconds) and the engine's bandwidth
 * estimate (line, scaled to its own peak) under the timeline. Same x scale
 * and margins as drawTimeline so the two read as one strip; stalls shaded.
 * Height follows the element, which takes the panel's spare room.
 */
export function drawBufferChart(
    el: SVGSVGElement,
    series: BufferSeries,
    breaks: AdBreak[],
    windowMs: number,
    range?: ChartRange,
): void {
    el.textContent = '';
    const W = Math.max(320, Math.round(el.clientWidth || 800));
    const H = Math.max(80, Math.round(el.clientHeight || 110));
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const L = 52;
    const R = 64;
    const top = 6;
    const bottom = H - 4;
    const now = range?.end ?? Date.now();
    const x = (t: number) => L + (1 - (now - t) / windowMs) * (W - L - R);
    const visible = (points: Point[]) => points.filter((p) => now - p.t <= windowMs);

    const shade = (spans: Span[], fill: string, opacity: number, name: string) => {
        for (const b of spans) {
            const x1 = Math.max(L, x(b.start));
            const x2 = Math.min(W - R, x(b.end ?? now));
            if (x2 <= L) continue;
            const rect = svg(
                'rect',
                {
                    x: x1,
                    y: top,
                    width: Math.max(2, x2 - x1),
                    height: bottom - top,
                    fill,
                    'fill-opacity': opacity,
                },
                el,
            );
            svg('title', {}, rect).textContent =
                `${name} · ${(((b.end ?? now) - b.start) / 1000).toFixed(1)} s`;
        }
    };
    shade(breaks, 'var(--scte)', 0.12, 'Ad break');
    shade(series.stalls, 'var(--error)', 0.22, 'Stalled');

    const buffer = visible(series.buffer);
    const maxB = Math.max(10, ...buffer.map((p) => p.v)) * 1.1;
    const step = niceStep(maxB / 3);
    const topB = Math.ceil(maxB / step) * step;
    const y = (v: number) => top + (1 - v / topB) * (bottom - top);
    for (let v = 0; v <= topB; v += step) {
        svg('line', {x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: css('--border')}, el);
        svg(
            'text',
            {x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'chart-label'},
            el,
        ).textContent = `${v}s`;
    }

    const labels: {y: number; text: string; color: string}[] = [];
    if (buffer.length > 1) {
        const pts = buffer.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
        const first = buffer[0] as Point;
        const last = buffer[buffer.length - 1] as Point;
        svg(
            'polygon',
            {
                points: `${x(first.t).toFixed(1)},${y(0)} ${pts} ${x(last.t).toFixed(1)},${y(0)}`,
                fill: 'var(--buffer)',
                'fill-opacity': 0.18,
            },
            el,
        );
        svg(
            'polyline',
            {points: pts, fill: 'none', stroke: 'var(--buffer)', 'stroke-width': 1.5},
            el,
        );
    }
    const lastB = series.buffer[series.buffer.length - 1];
    if (lastB)
        labels.push({y: y(lastB.v), text: `${lastB.v.toFixed(1)} s`, color: 'var(--buffer)'});

    const bandwidth = visible(series.bandwidth);
    const peak = Math.max(1, ...bandwidth.map((p) => p.v)) * 1.1;
    const yBw = (v: number) => top + (1 - v / peak) * (bottom - top);
    if (bandwidth.length > 1) {
        svg(
            'polyline',
            {
                points: bandwidth
                    .map((p) => `${x(p.t).toFixed(1)},${yBw(p.v).toFixed(1)}`)
                    .join(' '),
                fill: 'none',
                stroke: 'var(--bandwidth)',
                'stroke-width': 1.5,
                'stroke-linejoin': 'round',
            },
            el,
        );
    }
    const lastBw = series.bandwidth[series.bandwidth.length - 1];
    if (lastBw)
        labels.push({
            y: yBw(lastBw.v),
            text: `${(lastBw.v / 1e6).toFixed(1)} Mb/s`,
            color: 'var(--bandwidth)',
        });

    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) {
        const prev = labels[i - 1] as (typeof labels)[number];
        const cur = labels[i] as (typeof labels)[number];
        if (cur.y - prev.y < 12) cur.y = prev.y + 12;
    }
    for (const lab of labels) {
        svg(
            'text',
            {x: W - R + 8, y: Math.min(bottom, lab.y + 4), class: 'chart-value', fill: lab.color},
            el,
        ).textContent = lab.text;
    }
}

/** Minutes between time ticks so a range of `minutes` gets about eight. */
export function tickMinutes(minutes: number): number {
    for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 240]) if (minutes / step <= 8) return step;
    return 480;
}

function clockLabel(t: number): string {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 1, 2 or 5 × a power of ten, at least 5 (seconds). */
export function niceStep(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 5) return 5;
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}
