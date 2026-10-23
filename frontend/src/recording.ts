// /sessions/<id>: a saved session, read-only. Flask embeds the recording
// as JSON; this draws the same tiles, timeline and tables as the player,
// over the whole session instead of the last five minutes.

import './styles/player.css';
import {bandFor} from './lib/bands';
import {CLOCK_LABELS} from './lib/clock';
import type {Recording, StatsSummary} from './lib/recording';
import {drawBufferChart, drawLatencyChart, drawTimeline} from './ui/charts';
import {clock, h, kbps, resLabel, secs} from './ui/dom';

const KIND_ORDER = ['manifest', 'playlist', 'init', 'segment', 'key', 'license'];

function tile(label: string, value: string, hint: string, state: string | null = null) {
    const valueEl = h('span', {class: 'pl-vital__value'});
    valueEl.innerHTML = value;
    return h(
        'div',
        {class: `pl-vital${state ? ` ${state}` : ''}`},
        h('span', {class: 'pl-vital__label'}, label),
        valueEl,
        h('span', {class: 'pl-vital__hint'}, hint),
    );
}

function panel(title: string, note: string, ...children: (HTMLElement | SVGElement)[]) {
    return h(
        'section',
        {class: 'pl-panel'},
        h(
            'div',
            {class: 'pl-panel__head'},
            h('span', {class: 'pl-panel__title'}, title),
            h('span', {class: 'pl-muted'}, note),
        ),
        ...(children as HTMLElement[]),
    );
}

function table(head: string[], rows: string[][]): HTMLElement {
    return h(
        'div',
        {class: 'pl-table-wrap'},
        h(
            'table',
            {class: 'pl-defs'},
            h('thead', {}, h('tr', {}, ...head.map((c) => h('th', {}, c)))),
            h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c))))),
        ),
    );
}

const fmt = (v: number | null | undefined, unit = ' s') =>
    v === null || v === undefined ? '--' : `${v.toFixed(1)}${unit}`;

function duration(ms: number): string {
    const s = Math.round(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return hh ? `${hh} h ${mm} min` : mm ? `${mm} min ${ss} s` : `${ss} s`;
}

function statsRow(name: string, s: StatsSummary): string[] {
    return [name, fmt(s.last), fmt(s.avg), fmt(s.min), fmt(s.max), String(s.count)];
}

export function renderRecording(root: HTMLElement, r: Recording): void {
    const lat = r.stats.latency;
    const band = lat.avg === null ? null : bandFor(lat.avg);
    const c = r.counters;
    const span = Math.max(10000, r.endedAt - r.startedAt);
    const timeline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    timeline.setAttribute('class', 'pl-timeline');
    timeline.setAttribute('role', 'img');
    timeline.setAttribute('aria-label', 'Latency, drift and events over the session');
    // Buffer and bandwidth: recordings from v3.31.0 on.
    const hasBuffer = Boolean(r.series.buffer?.length || r.series.bandwidth?.length);
    const buffer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    buffer.setAttribute('class', 'pl-bufchart pl-bufchart--fixed');
    buffer.setAttribute('role', 'img');
    buffer.setAttribute('aria-label', 'Forward buffer and bandwidth estimate over the session');
    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.setAttribute('class', 'pl-chart');
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', 'Latency over the session');

    const chips = [
        r.live ? h('span', {class: 'chip chip--live'}, 'LIVE') : h('span', {class: 'chip'}, 'VOD'),
        h('span', {class: 'chip'}, `${r.source.engine} ${r.source.version}`),
        h('span', {class: 'chip'}, r.source.format === 'mpd' ? 'DASH' : 'HLS'),
        ...(r.source.drm ? [h('span', {class: 'chip'}, r.source.drm)] : []),
        h(
            'span',
            {class: 'chip'},
            `${clock(new Date(r.startedAt))} → ${clock(new Date(r.endedAt))}`,
        ),
        h('span', {class: 'chip'}, duration(r.endedAt - r.startedAt)),
    ];

    const kinds = Object.keys(r.requestStats).sort(
        (a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99),
    );
    const logList = h('div', {class: 'pl-log pl-log--tall'});
    const renderLog = (kind: string) => {
        const rows = r.log.filter((e) => kind === 'all' || e.kind === kind);
        logList.replaceChildren(
            ...rows.map((e) =>
                h(
                    'div',
                    {},
                    h('time', {}, clock(new Date(e.t))),
                    h('b', {class: `t-${e.kind}`}, e.label),
                    h('span', {class: 'pl-log__text'}, e.text),
                ),
            ),
        );
    };
    const logKinds = ['all', ...new Set(r.log.map((e) => e.kind))];
    const logFilter = h(
        'select',
        {
            class: 'pl-control',
            'aria-label': 'Show log entries of kind',
            onchange: (e: Event) => renderLog((e.target as HTMLSelectElement).value),
        },
        ...logKinds.map((k) => h('option', {value: k}, k === 'all' ? 'All entries' : k)),
    );

    root.replaceChildren(
        h(
            'div',
            {class: 'pl'},
            h('div', {class: 'pl-status', 'aria-label': 'Session properties'}, ...chips),
            h(
                'div',
                {class: 'pl-vitals', 'aria-label': 'Summary'},
                tile(
                    `Latency (${r.latencyName}) avg`,
                    lat.avg === null ? '--' : `${lat.avg.toFixed(1)}<small> s</small>`,
                    lat.count ? `min ${fmt(lat.min)} · max ${fmt(lat.max)}` : 'not measured',
                    band ? `band-${band.key}` : null,
                ),
                tile(
                    'Live-edge drift avg',
                    r.stats.drift.avg === null
                        ? '--'
                        : `${r.stats.drift.avg.toFixed(1)}<small> s</small>`,
                    `max ${fmt(r.stats.drift.max)}`,
                ),
                tile('Ray switches', String(c.switches ?? 0), `${r.renditions.length} rays`),
                tile(
                    'Rebuffers',
                    String(c.rebuffers ?? 0),
                    `${secs(c.stalledSeconds ?? 0)} stalled`,
                    c.rebuffers ? 'state-warn' : null,
                ),
                tile(
                    'Errors',
                    String(c.errors ?? 0),
                    `${c.httpErrors ?? 0} HTTP`,
                    c.errors ? 'state-bad' : null,
                ),
                tile(
                    'Segments',
                    String(c.segments ?? 0),
                    c.segmentAvgMs === null ? '' : `avg ${c.segmentAvgMs} ms · ${c.megabytes} MB`,
                ),
            ),
            panel(
                'Whole session',
                'seconds behind live · events below',
                timeline,
                h(
                    'div',
                    {class: 'pl-legend'},
                    h(
                        'span',
                        {},
                        h('i', {class: 'pl-legend__line', style: 'background:var(--accent)'}),
                        'Latency',
                    ),
                    h(
                        'span',
                        {},
                        h('i', {class: 'pl-legend__line pl-legend__line--dashed'}),
                        'Live-edge drift',
                    ),
                ),
            ),
            hasBuffer
                ? panel(
                      'Buffer & bandwidth',
                      'forward buffer (s) · ABR estimate, scaled to its peak · stalls red',
                      buffer,
                  )
                : null,
            h(
                'div',
                {class: 'pl-rec-grid'},
                panel(
                    'Latency',
                    `${r.latencyName} drives the headline`,
                    chart,
                    table(
                        ['Source', 'Last', 'Avg', 'Min', 'Max', 'Samples'],
                        [
                            statsRow('Encoder', r.stats.id3),
                            statsRow('PDT', r.stats.pdt),
                            statsRow('Drift', r.stats.drift),
                        ],
                    ),
                ),
                panel(
                    'Rays',
                    'the ladder at load',
                    table(
                        ['Ray', 'Resolution', 'fps', 'Profile / codecs', 'Bitrate'],
                        [...r.renditions]
                            .sort((a, b) => b.bitrate - a.bitrate)
                            .map((x) => [
                                x.ray ?? '·',
                                `${x.width}×${x.height} (${resLabel(x.height)})`,
                                x.fps ? String(x.fps) : '',
                                x.profile ?? x.codecs,
                                `${kbps(x.bitrate)}bps`,
                            ]),
                    ),
                ),
                panel(
                    'Requests',
                    'whole session, by kind',
                    table(
                        ['Kind', 'Count', 'Failed', 'Avg', 'p95', 'MB'],
                        kinds.map((k) => {
                            const s = r.requestStats[k];
                            return s
                                ? [
                                      k,
                                      String(s.count),
                                      String(s.failed),
                                      s.avgMs === null ? '--' : `${s.avgMs} ms`,
                                      s.p95Ms === null ? '--' : `${s.p95Ms} ms`,
                                      (s.bytes / 1e6).toFixed(1),
                                  ]
                                : [k];
                        }),
                    ),
                ),
                panel(
                    'DRM & keys',
                    r.drm?.keySystem ?? (r.source.drm || 'no DRM'),
                    table(
                        ['Item', 'Value'],
                        [
                            ['Licenses', `${c.licenses ?? 0} ok · ${c.licensesFailed ?? 0} failed`],
                            [
                                'Avg license',
                                c.licenseAvgMs === null ? '--' : `${c.licenseAvgMs} ms`,
                            ],
                            ['License server', r.drm?.licenseServer ?? '--'],
                            ['Robustness', r.drm?.robustness ?? '--'],
                            ['Content keys (HLS)', `${c.keys ?? 0} · avg ${c.keyAvgMs ?? '--'} ms`],
                            ...Object.entries(r.drm?.keyStatuses ?? {}).map(([id, st]) => [
                                `Key ${id.slice(0, 8)}…`,
                                st,
                            ]),
                        ],
                    ),
                ),
            ),
            panel(
                'Last requests',
                `${r.requests.length} most recent`,
                table(
                    ['Time', 'Kind', 'Request', 'Status', 'ms', 'First byte', 'KB'],
                    [...r.requests]
                        .reverse()
                        .map((q) => [
                            clock(new Date(q.start)),
                            q.kind,
                            q.url ? `${q.name} · ${q.url}` : q.name,
                            q.failed ? `✗ ${q.status ?? ''}` : String(q.status ?? ''),
                            String(q.end - q.start),
                            q.ttfbMs == null ? '--' : `${q.ttfbMs}`,
                            (q.bytes / 1024).toFixed(0),
                        ]),
                ),
            ),
            panel('Log', `${r.log.length} entries, newest first`, logFilter, logList),
            panel(
                'Environment',
                '',
                table(
                    ['Item', 'Value'],
                    [
                        ['Source', r.source.url],
                        ...(r.clock
                            ? [
                                  [
                                      'Program dates',
                                      `${CLOCK_LABELS[r.clock.kind].name}${r.clock.offsetS === null ? '' : ` · +${r.clock.offsetS.toFixed(1)} s`}`,
                                  ],
                                  [
                                      'Uplynk delay',
                                      r.clock.delay === null ? 'default' : `${r.clock.delay} s`,
                                  ],
                              ]
                            : []),
                        ...(r.cmcd ? [['CMCD session', r.cmcd.sessionId]] : []),
                        ['Browser', r.userAgent],
                        ...(r.playlist
                            ? Object.entries(r.playlist).map(([k, v]) => [
                                  k,
                                  v !== null && typeof v === 'object'
                                      ? JSON.stringify(v)
                                      : String(v),
                              ])
                            : []),
                    ],
                ),
            ),
        ),
    );
    renderLog('all');
    const draw = () => {
        drawTimeline(
            timeline,
            {
                latency: r.series.latency,
                latencyLabel: `Latency (${r.latencyName})`,
                drift: r.series.drift,
            },
            r.events as Parameters<typeof drawTimeline>[2],
            r.breaks,
            span,
            {end: r.endedAt},
        );
        if (hasBuffer)
            drawBufferChart(
                buffer,
                {
                    buffer: r.series.buffer ?? [],
                    bandwidth: r.series.bandwidth ?? [],
                    stalls: r.stalls ?? [],
                },
                r.breaks,
                span,
                {end: r.endedAt},
            );
        drawLatencyChart(chart, r.series.latency, span, {end: r.endedAt});
    };
    draw();
    window.addEventListener('resize', draw);
}

const root = document.getElementById('recording-app');
const data = document.getElementById('recording-data')?.textContent;
if (root && data) renderRecording(root, JSON.parse(data) as Recording);
