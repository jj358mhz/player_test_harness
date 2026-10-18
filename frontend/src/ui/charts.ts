// SVG charts: the latency chart in the Latency tab and the event timeline
// under the video. Both share one time window.

import {BANDS} from '../lib/bands';
import type {Point} from '../lib/stats';
import {svg} from './dom';

const css = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawLatencyChart(el: SVGSVGElement, points: Point[], windowMs: number): void {
    el.textContent = '';
    const W = 560;
    const H = 160;
    const L = 34;
    const R = 8;
    const T = 8;
    const B = 20;
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const maxV = Math.max(15, ...points.map((p) => p.v)) * 1.1;
    const step = niceStep(maxV / 5); // about five grid lines whatever the range
    const top = Math.ceil(maxV / step) * step;
    const now = Date.now();
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
    const labels: [string, number, string][] = [
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

export function drawTimeline(
    el: SVGSVGElement,
    latency: Point[],
    events: TimelineEvent[],
    breaks: AdBreak[],
    windowMs: number,
): void {
    el.textContent = '';
    const W = 800;
    const H = 86;
    el.setAttribute('viewBox', `0 0 ${W} ${H}`);
    el.setAttribute('preserveAspectRatio', 'none');
    const now = Date.now();
    const x = (t: number) => (1 - (now - t) / windowMs) * W;

    for (const b of breaks) {
        const x1 = Math.max(0, x(b.start));
        const x2 = Math.min(W, x(b.end ?? now));
        if (x2 <= 0) continue;
        const rect = svg(
            'rect',
            {
                x: x1,
                y: 0,
                width: Math.max(2, x2 - x1),
                height: H,
                fill: 'var(--scte)',
                'fill-opacity': 0.14,
            },
            el,
        );
        svg('title', {}, rect).textContent = `Ad break · ${b.label}`;
        if (x2 - x1 > 60) {
            const seconds = Math.round(((b.end ?? now) - b.start) / 1000);
            svg(
                'text',
                {x: x1 + 6, y: 11, class: 'chart-label chart-label--scte'},
                el,
            ).textContent =
                `Ad break · ${seconds}${b.planned ? ` of ${Math.round(b.planned)}` : ''} s`;
        }
    }

    if (latency.length > 1) {
        const vs = latency.map((p) => p.v);
        const lo = Math.min(...vs);
        const hi = Math.max(...vs, lo + 2);
        const y = (v: number) => 10 + (1 - (v - lo) / (hi - lo)) * 30;
        svg(
            'polyline',
            {
                points: latency.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '),
                fill: 'none',
                stroke: 'var(--accent)',
                'stroke-width': 1.5,
                'vector-effect': 'non-scaling-stroke',
            },
            el,
        );
    }
    svg(
        'line',
        {
            x1: 0,
            x2: W,
            y1: 50,
            y2: 50,
            stroke: css('--border'),
            'vector-effect': 'non-scaling-stroke',
        },
        el,
    );
    for (const e of events) {
        const ex = x(e.t);
        if (ex < 0) continue;
        let mark: SVGElement;
        if (e.kind === 'abr')
            mark = svg(
                'rect',
                {x: ex - 4, y: 55, width: 8, height: 10, rx: 2, fill: 'var(--info)'},
                el,
            );
        else if (e.kind === 'key')
            mark = svg('rect', {x: ex - 1, y: 56, width: 2, height: 8, fill: 'var(--warn)'}, el);
        else if (e.kind === 'scte')
            mark = svg(
                'rect',
                {x: ex - 3, y: 4, width: 6, height: 78, fill: 'var(--scte)', 'fill-opacity': 0.5},
                el,
            );
        else if (e.kind === 'disc')
            mark = svg(
                'rect',
                {x: ex - 1, y: 70, width: 2, height: 12, fill: 'var(--text-dim)'},
                el,
            );
        else mark = svg('circle', {cx: ex, cy: 76, r: 5, fill: 'var(--error)'}, el);
        svg('title', {}, mark).textContent = e.label;
    }
}

/** 1, 2 or 5 × a power of ten, at least 5 (seconds). */
export function niceStep(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 5) return 5;
    const power = 10 ** Math.floor(Math.log10(raw));
    const unit = raw / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}
