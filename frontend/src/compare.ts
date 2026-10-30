// /compare: two players side by side on the same clock. Each pane is the
// full player in an iframe (/player?embed=1&…); this page reads both through
// window.playerApp.snapshot() once a second and lines the numbers up.

import './styles/player.css';
import type {PlayerApp} from './app';
import type {ChannelOption} from './config';
import {channelGroups, channelLabel} from './config';
import {bandFor} from './lib/bands';
import {
    compareSearch,
    delta,
    type PaneSnapshot,
    PRESETS,
    type Preset,
    parseCompare,
    presetQueries,
} from './lib/compare';
import {parseView, viewQuery} from './lib/deeplink';
import {drawLatencyLines} from './ui/charts';
import {h, kbps} from './ui/dom';

interface CompareConfig {
    channels: ChannelOption[];
    player: string;
}

const PANES = ['a', 'b'] as const;
type Pane = (typeof PANES)[number];
const COLORS: Record<Pane, string> = {a: 'var(--accent)', b: 'var(--info)'};
const WINDOW_MS = 5 * 60 * 1000;

type Row = {
    label: string;
    title?: string;
    value: (s: PaneSnapshot) => string;
    /** Numeric value for the B − A column; omit for text rows. */
    num?: (s: PaneSnapshot) => number | null;
    unit?: string;
    digits?: number;
    /** Colour the latency cell by band. */
    band?: boolean;
};

const s1 = (v: number | null | undefined, unit = ' s') =>
    v === null || v === undefined ? '--' : `${v.toFixed(1)}${unit}`;

const ROWS: Row[] = [
    {
        label: 'Player',
        value: (s) =>
            [
                s.title ?? '--',
                s.format === 'mpd' ? 'DASH' : 'HLS',
                `${s.engine} ${s.version}`,
                s.drm,
                s.delay !== null ? `delay ${s.delay} s` : null,
            ]
                .filter(Boolean)
                .join(' · '),
    },
    {label: 'Clock', value: (s) => s.clock ?? '--'},
    {
        label: 'Latency now',
        title: 'Headline latency: ID3 when the stream has it, otherwise program dates on the clock above',
        value: (s) => `${s1(s.latency.last)}${s.latency.count ? ` (${s.latencyName})` : ''}`,
        num: (s) => s.latency.last,
        unit: ' s',
        band: true,
    },
    {
        label: 'Latency avg',
        value: (s) => s1(s.latency.avg),
        num: (s) => s.latency.avg,
        unit: ' s',
    },
    {
        label: 'Latency min / max',
        value: (s) => `${s1(s.latency.min, '')} / ${s1(s.latency.max)}`,
    },
    {
        label: 'Live-edge drift',
        value: (s) => s1(s.drift),
        num: (s) => s.drift,
        unit: ' s',
    },
    {label: 'Buffer', value: (s) => s1(s.buffer), num: (s) => s.buffer, unit: ' s'},
    {
        label: 'Ray',
        value: (s) =>
            s.ray || s.height
                ? `${s.ray ?? '·'} ${s.height ? `${s.height}p` : ''} ${s.bitrate ? `${kbps(s.bitrate)}bps` : ''}`
                : '--',
        num: (s) => (s.bitrate === null ? null : s.bitrate / 1000),
        unit: ' kbps',
        digits: 0,
    },
    {
        label: 'Bandwidth estimate',
        value: (s) => (s.bandwidth ? `${kbps(s.bandwidth)}bps` : '--'),
        num: (s) => (s.bandwidth === null ? null : s.bandwidth / 1000),
        unit: ' kbps',
        digits: 0,
    },
    {
        label: 'Startup',
        title: 'Engine load to first frame (signing not included)',
        value: (s) => (s.startupMs === null ? '--' : `${s.startupMs} ms`),
        num: (s) => s.startupMs,
        unit: ' ms',
        digits: 0,
    },
    {
        label: 'Rebuffers',
        value: (s) => `${s.rebuffers} · ${s.stalledS.toFixed(1)} s stalled`,
        num: (s) => s.rebuffers,
        digits: 0,
    },
    {label: 'Errors', value: (s) => String(s.errors), num: (s) => s.errors, digits: 0},
    {label: 'Ray switches', value: (s) => String(s.switches), num: (s) => s.switches, digits: 0},
    {
        label: 'Segment avg',
        value: (s) => (s.segmentAvgMs === null ? '--' : `${s.segmentAvgMs} ms`),
        num: (s) => s.segmentAvgMs,
        unit: ' ms',
        digits: 0,
    },
];

class ComparePage {
    private frames = {} as Record<Pane, HTMLIFrameElement>;
    private cells = new Map<string, HTMLElement>();
    private notices = h('div', {class: 'pl-notices', 'aria-live': 'polite'});
    private chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    private channel: HTMLSelectElement;
    private preset: HTMLSelectElement;

    constructor(
        root: HTMLElement,
        private config: CompareConfig,
    ) {
        this.chart.setAttribute('class', 'pl-chart');
        this.chart.setAttribute('role', 'img');
        this.chart.setAttribute('aria-label', 'Latency of both panes, last five minutes');
        this.channel = h(
            'select',
            {id: 'cmp-channel', class: 'pl-control'},
            ...channelGroups(config.channels).map(([account, channels]) =>
                h(
                    'optgroup',
                    {label: account},
                    ...channels.map((c) => h('option', {value: String(c.id)}, channelLabel(c))),
                ),
            ),
        );
        this.preset = h(
            'select',
            {id: 'cmp-preset', class: 'pl-control'},
            ...Object.entries(PRESETS).map(([key, p]) => h('option', {value: key}, p.label)),
        );
        const initial = parseCompare(location.search);
        const firstChannel = parseView(initial.a ?? '').channel;
        if (firstChannel) this.channel.value = String(firstChannel);
        root.replaceChildren(this.build());
        for (const pane of PANES) this.show(pane, initial[pane]);
        setInterval(() => this.tick(), 1000);
    }

    private build(): HTMLElement {
        const head = h(
            'tr',
            {},
            h('th', {}, ''),
            ...PANES.map((p) => this.paneHead(p)),
            h('th', {}, 'B − A'),
        );
        const body = ROWS.map((row) =>
            h(
                'tr',
                {},
                h('td', {title: row.title ?? ''}, row.label),
                ...PANES.map((p) => this.cell(`${row.label}:${p}`, 'pl-v')),
                this.cell(`${row.label}:d`, 'num'),
            ),
        );
        return h(
            'div',
            {class: 'pl'},
            this.notices,
            h(
                'form',
                {
                    class: 'pl-loadbar cmp-bar',
                    'aria-label': 'Load both panes',
                    onsubmit: (e: Event) => {
                        e.preventDefault();
                        this.loadPreset();
                    },
                },
                h(
                    'div',
                    {class: 'pl-field'},
                    h('label', {for: 'cmp-channel'}, 'Channel'),
                    this.channel,
                ),
                h(
                    'div',
                    {class: 'pl-field'},
                    h('label', {for: 'cmp-preset'}, 'Compare'),
                    this.preset,
                ),
                h(
                    'div',
                    {class: 'pl-field pl-field--actions cmp-actions'},
                    h('button', {class: 'pl-btn-primary', type: 'submit'}, 'Load both'),
                    h(
                        'button',
                        {
                            class: 'pl-btn-ghost',
                            type: 'button',
                            title: 'Copy a link to both views',
                            onclick: (e: Event) =>
                                void this.copyLink(e.currentTarget as HTMLButtonElement),
                        },
                        'Copy link',
                    ),
                    h(
                        'button',
                        {
                            class: 'pl-btn-ghost',
                            type: 'button',
                            title: 'Save both panes as recorded sessions',
                            onclick: (e: Event) =>
                                void this.saveBoth(e.currentTarget as HTMLButtonElement),
                        },
                        'Save both',
                    ),
                ),
            ),
            h(
                'div',
                {class: 'cmp-summary'},
                h(
                    'section',
                    {class: 'pl-panel'},
                    h(
                        'div',
                        {class: 'pl-table-wrap'},
                        h(
                            'table',
                            {class: 'pl-defs cmp-table'},
                            h('thead', {}, head),
                            h('tbody', {}, ...body),
                        ),
                    ),
                ),
                h(
                    'section',
                    {class: 'pl-panel'},
                    h(
                        'div',
                        {class: 'pl-panel__head'},
                        h('span', {class: 'pl-panel__title'}, 'Latency, last 5 minutes'),
                        h(
                            'span',
                            {class: 'pl-legend'},
                            ...PANES.map((p) =>
                                h(
                                    'span',
                                    {},
                                    h('i', {
                                        class: 'pl-legend__line',
                                        style: `background:${COLORS[p]}`,
                                    }),
                                    p.toUpperCase(),
                                ),
                            ),
                        ),
                    ),
                    this.chart,
                    h(
                        'p',
                        {class: 'pl-muted'},
                        'Both on the encoder clock for synced channels: HLS signed with pdts=latency, DASH corrected by the measured MPD offset.',
                    ),
                ),
            ),
            h(
                'div',
                {class: 'cmp-panes'},
                ...PANES.map((p) => {
                    const frame = h('iframe', {
                        class: 'cmp-frame',
                        title: `Player ${p.toUpperCase()}`,
                        allow: 'autoplay; encrypted-media; fullscreen; clipboard-write',
                    });
                    this.frames[p] = frame;
                    return h(
                        'section',
                        {class: `cmp-pane cmp-pane--${p}`},
                        h(
                            'div',
                            {class: 'cmp-pane__label', style: `border-color:${COLORS[p]}`},
                            p.toUpperCase(),
                        ),
                        frame,
                    );
                }),
            ),
        );
    }

    private paneHead(p: Pane): HTMLElement {
        return h(
            'th',
            {},
            h('span', {class: 'cmp-dot', style: `background:${COLORS[p]}`}),
            p.toUpperCase(),
        );
    }

    private cell(key: string, cls: string): HTMLElement {
        const td = h('td', {class: cls}, '--');
        this.cells.set(key, td);
        return td;
    }

    private show(pane: Pane, query: string | null): void {
        this.frames[pane].src = `${this.config.player}?embed=1${query ? `&${query}` : ''}`;
    }

    private loadPreset(): void {
        const channel = Number(this.channel.value);
        if (!channel) return;
        const queries = presetQueries(this.preset.value as Preset, channel);
        for (const pane of PANES) this.show(pane, queries[pane]);
        this.notices.replaceChildren();
    }

    private app(pane: Pane): PlayerApp | null {
        try {
            return (
                (this.frames[pane].contentWindow as (Window & {playerApp?: PlayerApp}) | null)
                    ?.playerApp ?? null
            );
        } catch {
            return null;
        }
    }

    /** The pane's current player query, as its own address bar has it. */
    private paneQuery(pane: Pane): string {
        try {
            const search = this.frames[pane].contentWindow?.location.search ?? '';
            return viewQuery(parseView(search));
        } catch {
            return '';
        }
    }

    private tick(): void {
        const snaps = {} as Record<Pane, PaneSnapshot | null>;
        for (const pane of PANES) {
            snaps[pane] = this.app(pane)?.snapshot() ?? null;
            // Grow each frame to its content so the page scrolls, not the panes.
            const doc = this.frames[pane].contentDocument;
            if (doc?.body) this.frames[pane].style.height = `${doc.documentElement.scrollHeight}px`;
        }
        for (const row of ROWS) {
            for (const pane of PANES) {
                const td = this.cells.get(`${row.label}:${pane}`);
                const snap = snaps[pane];
                if (!td) continue;
                td.textContent = snap ? row.value(snap) : '--';
                const v = snap && row.band ? snap.latency.last : null;
                td.className = `pl-v${v !== null ? ` cmp-band band-${bandFor(v).key}` : ''}`;
            }
            const d = this.cells.get(`${row.label}:d`);
            if (!d) continue;
            const diff =
                row.num && snaps.a && snaps.b ? delta(row.num(snaps.a), row.num(snaps.b)) : null;
            d.textContent =
                diff === null
                    ? ''
                    : `${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff).toLocaleString('en-US', {minimumFractionDigits: row.digits ?? 1, maximumFractionDigits: row.digits ?? 1})}${row.unit ?? ''}`;
        }
        drawLatencyLines(
            this.chart,
            PANES.map((p) => ({points: snaps[p]?.series ?? [], color: COLORS[p]})),
            WINDOW_MS,
        );
        const search = compareSearch(this.paneQuery('a'), this.paneQuery('b'));
        if (`?${search}` !== location.search)
            history.replaceState(null, '', `${location.pathname}?${search}`);
    }

    private async copyLink(button: HTMLButtonElement): Promise<void> {
        try {
            await navigator.clipboard.writeText(location.href);
            button.textContent = 'Copied ✓';
        } catch {
            button.textContent = 'Copy failed';
        }
        setTimeout(() => {
            button.textContent = 'Copy link';
        }, 1500);
    }

    private async saveBoth(button: HTMLButtonElement): Promise<void> {
        button.disabled = true;
        this.notices.replaceChildren();
        try {
            const saved = await Promise.all(PANES.map((p) => this.app(p)?.save() ?? null));
            const links = PANES.flatMap((p, i) => {
                const s = saved[i];
                return s ? [{pane: p, url: new URL(s.url, location.href).href}] : [];
            });
            if (!links.length) {
                this.notice('error', 'Load a stream in at least one pane first.');
                return;
            }
            const text = links.map((l) => `${l.pane.toUpperCase()}: ${l.url}`).join('\n');
            await navigator.clipboard
                ?.writeText(`Compare: ${location.href}\n${text}`)
                .catch(() => undefined);
            this.notice(
                'info',
                'Saved; links copied.',
                ...links.map((l) =>
                    h(
                        'a',
                        {href: l.url, target: '_blank', rel: 'noopener'},
                        `Open ${l.pane.toUpperCase()}`,
                    ),
                ),
            );
        } catch (err) {
            this.notice('error', `Could not save: ${(err as Error).message}`);
        } finally {
            button.disabled = false;
        }
    }

    private notice(kind: 'info' | 'error', message: string, ...actions: HTMLElement[]): void {
        this.notices.append(
            h(
                'div',
                {class: `flash flash--${kind} pl-notice`},
                h('span', {}, message),
                h('span', {class: 'pl-notice__actions'}, ...actions),
            ),
        );
    }
}

const root = document.getElementById('compare-app');
const data = document.getElementById('compare-config')?.textContent;
if (root && data) new ComparePage(root, JSON.parse(data) as CompareConfig);
