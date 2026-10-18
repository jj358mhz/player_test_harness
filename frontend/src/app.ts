// The player page: load bar, video + vitals + timeline, tabbed inspector.
// Engine-agnostic: everything here talks to a PlayerEngine.

import {
    type EngineVersion,
    fetchVersions,
    type PlaybackResponse,
    type Probe,
    requestPlayback,
} from './api';
import type {ChannelOption, PlayerConfig} from './config';
import {DEFAULT_HLS_VERSION, HlsJsEngine, loadHlsJs} from './engines/hlsjs';
import type {
    AudioTrack,
    EngineEvents,
    MediaPlaylistInfo,
    PlayerEngine,
    Rendition,
    RequestTiming,
} from './engines/types';
import {BANDS, bandFor} from './lib/bands';
import {parsePriv, parseTxxx, toHex} from './lib/id3';
import {Id3Clock} from './lib/latency';
import {raysParam} from './lib/rays';
import {decodeScte35, describeScte35, hexToBytes, type SpliceInfo} from './lib/scte35';
import {RunningStats, Series} from './lib/stats';
import {
    type AdBreak,
    drawLatencyChart,
    drawTimeline,
    type TimelineEvent,
    type TimelineKind,
} from './ui/charts';
import {clock, h, kbps, mbps, resLabel, secs} from './ui/dom';

const WINDOW_MS = 5 * 60 * 1000;
const LOG_LIMIT = 300;
const CUSTOM = '__custom__';
const PASTE = '__paste__';
const WATERFALL_MS = 30 * 1000;

type LogKind = TimelineKind | 'id3' | 'info';

interface LogEntry {
    t: Date;
    kind: LogKind;
    label: string;
    text: string;
}

interface Source {
    channel: ChannelOption | null;
    url: string;
    expiresAt: Date | null;
}

/** Everything measured for one loaded stream; replaced on each load. */
class Session {
    id3 = new Id3Clock();
    latency = {id3: new RunningStats(), pdt: new RunningStats(), drift: new RunningStats()};
    series = new Series(WINDOW_MS);
    timeline: TimelineEvent[] = [];
    log: LogEntry[] = [];
    renditions: Rendition[] = [];
    master: string | null = null;
    live = true;
    switches = 0;
    rebuffers = 0;
    stalledMs = 0;
    stallStart: number | null = null;
    errors = 0;
    errorsHttp = 0;
    segments = {count: 0, ms: 0, bytes: 0, last: null as EngineEvents['segment'] | null};
    keys = {count: 0, uris: new Set<string>(), method: null as string | null, ms: [] as number[]};
    id3Count = 0;
    scteCount = 0;
    lastSync = 0;
    breaks: AdBreak[] = [];
    lastScte: {info: SpliceInfo; at: Date; source: string} | null = null;
    requests: RequestTiming[] = [];
    playlist: MediaPlaylistInfo | null = null;
    audio: {tracks: AudioTrack[]; current: number} = {tracks: [], current: -1};
    asset: {assetId: string; kind: string} | null = null;
    pending: number[] = []; // timers to cancel on reload
}

export class PlayerApp {
    private engine: PlayerEngine | null = null;
    private session = new Session();
    private source: Source | null = null;
    private versions: EngineVersion[] = [];
    private disabledRays = new Set<string>();
    private manifestView: 'master' | 'media' = 'master';
    private readonly video: HTMLVideoElement;
    private readonly refs: Record<string, HTMLElement> = {};
    private readonly svgs: Record<'chart' | 'timeline', SVGSVGElement>;

    constructor(
        private root: HTMLElement,
        private config: PlayerConfig,
    ) {
        this.video = h('video', {controls: true, muted: true, autoplay: true, playsinline: true});
        this.svgs = {
            chart: document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
            timeline: document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        };
        this.svgs.chart.setAttribute('class', 'pl-chart');
        this.svgs.timeline.setAttribute('class', 'pl-timeline');
        this.svgs.chart.setAttribute('role', 'img');
        this.svgs.chart.setAttribute('aria-label', 'Latency over the last five minutes');
        this.svgs.timeline.setAttribute('role', 'img');
        this.svgs.timeline.setAttribute('aria-label', 'Events over the last five minutes');
        this.root.append(this.build());
        this.watchVideo();
        setInterval(() => this.tick(), 1000);
        void this.loadVersions();
        this.start();
    }

    // ------------------------------------------------------------------ layout

    private ref<T extends HTMLElement>(name: string, el: T): T {
        this.refs[name] = el;
        return el;
    }

    private el<T extends HTMLElement = HTMLElement>(name: string): T {
        return this.refs[name] as T;
    }

    private build(): HTMLElement {
        return h(
            'div',
            {class: 'pl'},
            this.ref('notices', h('div', {class: 'pl-notices', 'aria-live': 'polite'})),
            this.buildLoadBar(),
            this.ref('status', h('div', {class: 'pl-status', 'aria-label': 'Stream properties'})),
            h(
                'div',
                {class: 'pl-main'},
                h(
                    'div',
                    {class: 'pl-stage'},
                    h(
                        'div',
                        {class: 'pl-video'},
                        this.video,
                        h(
                            'div',
                            {class: 'pl-hud'},
                            this.ref('hudRay', h('span', {class: 'chip'}, 'no stream')),
                            this.ref('hudLatency', h('span', {class: 'chip num'})),
                        ),
                    ),
                    this.buildVitals(),
                    h(
                        'section',
                        {class: 'pl-panel', 'aria-label': 'Event timeline'},
                        h(
                            'div',
                            {class: 'pl-panel__head'},
                            h('span', {class: 'pl-panel__title'}, 'Last 5 minutes'),
                            h('span', {class: 'pl-muted'}, 'latency line · events on one axis'),
                        ),
                        this.svgs.timeline,
                        h(
                            'div',
                            {class: 'pl-legend'},
                            ...(
                                [
                                    ['info', 'Ray switch'],
                                    ['warn', 'Key load'],
                                    ['scte', 'SCTE-35'],
                                    ['text-dim', 'Discontinuity'],
                                    ['error', 'Error'],
                                ] as const
                            ).map(([c, label]) =>
                                h('span', {}, h('i', {style: `background:var(--${c})`}), label),
                            ),
                        ),
                    ),
                ),
                this.buildInspector(),
            ),
        );
    }

    private buildLoadBar(): HTMLElement {
        const groups = new Map<string, ChannelOption[]>();
        for (const c of this.config.channels) {
            groups.set(c.account, [...(groups.get(c.account) ?? []), c]);
        }
        const source = this.ref(
            'source',
            h(
                'select',
                {id: 'pl-source', class: 'pl-control', onchange: () => this.syncSourceInput()},
                ...[...groups].map(([account, channels]) =>
                    h(
                        'optgroup',
                        {label: account},
                        ...channels.map((c) =>
                            h(
                                'option',
                                {value: String(c.id)},
                                `${c.favorite ? '★ ' : ''}${c.name}`,
                            ),
                        ),
                    ),
                ),
                h('option', {value: PASTE}, 'Paste a URL…'),
            ),
        );
        const engine = this.ref(
            'engine',
            h(
                'select',
                {id: 'pl-engine', class: 'pl-control', onchange: () => this.syncEngineInput()},
                h(
                    'option',
                    {value: DEFAULT_HLS_VERSION},
                    `hls.js ${DEFAULT_HLS_VERSION} (default)`,
                ),
                h('option', {value: CUSTOM}, 'Custom version…'),
            ),
        );
        return h(
            'form',
            {
                class: 'pl-loadbar',
                'aria-label': 'Load a stream',
                onsubmit: (e: Event) => {
                    e.preventDefault();
                    void this.loadFromForm();
                },
            },
            h(
                'div',
                {class: 'pl-field pl-field--source'},
                h('label', {for: 'pl-source'}, 'Channel or URL'),
                source,
                this.ref(
                    'url',
                    h('input', {
                        id: 'pl-url',
                        class: 'pl-control mono',
                        type: 'url',
                        placeholder: 'https://content.uplynk.com/channel/….m3u8?…',
                        hidden: true,
                        'aria-label': 'Stream URL',
                    }),
                ),
            ),
            h(
                'div',
                {class: 'pl-field'},
                h('span', {class: 'pl-label', id: 'pl-format-label'}, 'Format'),
                h(
                    'div',
                    {class: 'pl-seg', role: 'group', 'aria-labelledby': 'pl-format-label'},
                    h('button', {type: 'button', 'aria-pressed': 'true'}, 'HLS'),
                    h(
                        'button',
                        {
                            type: 'button',
                            'aria-pressed': 'false',
                            disabled: true,
                            title: 'DASH playback needs Shaka or dash.js (Phase 2)',
                        },
                        'DASH',
                    ),
                ),
            ),
            h(
                'div',
                {class: 'pl-field'},
                h('label', {for: 'pl-engine'}, 'Player engine'),
                engine,
                this.ref(
                    'engineCustom',
                    h('input', {
                        class: 'pl-control mono',
                        placeholder: 'e.g. 1.6.15',
                        hidden: true,
                        'aria-label': 'hls.js version',
                        pattern: '\\d+\\.\\d+\\.\\d+(-[\\w.]+)?',
                    }),
                ),
            ),
            h(
                'div',
                {class: 'pl-field'},
                h('label', {for: 'pl-drm'}, 'DRM'),
                h(
                    'select',
                    {
                        id: 'pl-drm',
                        class: 'pl-control',
                        disabled: true,
                        title: 'DRM playback arrives in Phase 3',
                    },
                    h('option', {}, 'None'),
                ),
            ),
            h(
                'div',
                {class: 'pl-field pl-field--actions'},
                h('button', {class: 'pl-btn-primary', type: 'submit'}, 'Load'),
            ),
        );
    }

    private buildVitals(): HTMLElement {
        const vital = (key: string, label: string, title: string) =>
            this.ref(
                `v-${key}`,
                h(
                    'div',
                    {class: 'pl-vital', title},
                    h('span', {class: 'pl-vital__label'}, label),
                    h('span', {class: 'pl-vital__value'}, '--'),
                    h('span', {class: 'pl-vital__hint'}, ' '),
                ),
            );
        return h(
            'div',
            {class: 'pl-vitals', 'aria-label': 'Vitals'},
            vital(
                'latency',
                'Latency',
                'Encoder wallclock (ID3) to now, at the playhead; PDT if the stream has no ID3',
            ),
            vital('drift', 'Live-edge drift', 'Playhead to the live edge of the playlist'),
            vital('buffer', 'Buffer', 'Seconds buffered ahead of the playhead'),
            vital('ray', 'Ray', 'Uplynk rendition currently playing'),
            vital('rebuffers', 'Rebuffers', 'Stalls after playback started'),
            vital('errors', 'Errors', 'Player errors since load'),
        );
    }

    private buildInspector(): HTMLElement {
        const tabs: [string, string, HTMLElement][] = [
            ['latency', 'Latency', this.buildLatencyPanel()],
            ['abr', 'ABR', this.buildAbrPanel()],
            ['keys', 'DRM & keys', this.buildKeysPanel()],
            ['meta', 'Metadata', this.buildMetaPanel()],
            ['tracks', 'Tracks', this.buildTracksPanel()],
            ['manifest', 'Manifest', this.buildManifestPanel()],
            ['network', 'Network', this.buildNetworkPanel()],
            ['log', 'Log', this.buildLogPanel()],
        ];
        const list = h('div', {
            class: 'pl-tabs',
            role: 'tablist',
            'aria-label': 'Inspector panels',
        });
        const panels: HTMLElement[] = [];
        const buttons: HTMLButtonElement[] = [];
        const select = (index: number, focus = false) => {
            buttons.forEach((b, i) => {
                const on = i === index;
                b.setAttribute('aria-selected', String(on));
                b.tabIndex = on ? 0 : -1;
                (panels[i] as HTMLElement).hidden = !on;
            });
            if (focus) buttons[index]?.focus();
            const key = tabs[index]?.[0];
            if (key)
                history.replaceState(null, '', `${location.pathname}${location.search}#${key}`);
        };
        tabs.forEach(([key, label, panel], i) => {
            const button = this.ref(
                `tab-${key}`,
                h(
                    'button',
                    {
                        type: 'button',
                        class: 'pl-tab',
                        role: 'tab',
                        id: `pl-tab-${key}`,
                        'aria-controls': `pl-panel-${key}`,
                        onclick: () => select(i),
                        onkeydown: (e: Event) => {
                            const k = (e as KeyboardEvent).key;
                            if (k === 'ArrowRight') select((i + 1) % tabs.length, true);
                            if (k === 'ArrowLeft')
                                select((i - 1 + tabs.length) % tabs.length, true);
                        },
                    },
                    label,
                    this.ref(`count-${key}`, h('span', {class: 'pl-tab__count'})),
                ),
            );
            panel.id = `pl-panel-${key}`;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', `pl-tab-${key}`);
            panel.classList.add('pl-tabpanel');
            buttons.push(button);
            panels.push(panel);
            list.append(button);
        });
        const initial = Math.max(
            0,
            tabs.findIndex(([key]) => `#${key}` === location.hash),
        );
        const section = h(
            'section',
            {class: 'pl-panel pl-inspector', 'aria-label': 'Inspector'},
            list,
            ...panels,
        );
        select(initial);
        return section;
    }

    private buildLatencyPanel(): HTMLElement {
        const tile = (key: string, label: string) =>
            this.ref(
                `t-${key}`,
                h(
                    'div',
                    {class: 'pl-vital'},
                    h('span', {class: 'pl-vital__label'}, label),
                    h('span', {class: 'pl-vital__value'}, '--'),
                    h('span', {class: 'pl-vital__hint'}, ' '),
                ),
            );
        const row = (key: string, name: string, what: string) =>
            h(
                'tr',
                {},
                h('td', {}, name, h('span', {class: 'pl-what'}, what)),
                this.ref(`now-${key}`, h('td', {class: 'pl-v'}, '--')),
                this.ref(`range-${key}`, h('td', {class: 'num'}, '--')),
            );
        return h(
            'div',
            {},
            h(
                'div',
                {},
                this.ref('tilesTitle', h('p', {class: 'pl-subhead'}, 'Latency since load')),
                h(
                    'div',
                    {class: 'pl-tiles', 'aria-live': 'polite'},
                    tile('now', 'Current'),
                    tile('avg', 'Average'),
                    tile('max', 'Max'),
                    tile('min', 'Min'),
                ),
                h(
                    'div',
                    {class: 'pl-bands'},
                    ...BANDS.map((b, i) => {
                        const lower = i === 0 ? 0 : (BANDS[i - 1]?.below ?? 0);
                        const range =
                            i === 0
                                ? `<${b.below} s`
                                : Number.isFinite(b.below)
                                  ? `${lower}–${b.below}`
                                  : `>${lower}`;
                        return h(
                            'span',
                            {class: `band-${b.key}`},
                            h('i', {}),
                            `${b.label} ${range}`,
                        );
                    }),
                ),
            ),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Three ways to measure it'),
                h(
                    'div',
                    {class: 'pl-table-wrap'},
                    h(
                        'table',
                        {class: 'pl-defs'},
                        h(
                            'thead',
                            {},
                            h(
                                'tr',
                                {},
                                h('th', {}, 'Source'),
                                h('th', {}, 'Now'),
                                h('th', {}, 'Min / Avg / Max'),
                            ),
                        ),
                        h(
                            'tbody',
                            {},
                            row(
                                'id3',
                                'ID3 wallclock',
                                'Encoder timestamp in the segment → now, at the playhead',
                            ),
                            row(
                                'pdt',
                                'Program date-time',
                                '#EXT-X-PROGRAM-DATE-TIME at the playhead → now',
                            ),
                            row('drift', 'Live-edge drift', 'Playhead → live edge of the playlist'),
                        ),
                    ),
                ),
            ),
            h(
                'div',
                {},
                this.ref('chartTitle', h('p', {class: 'pl-subhead'}, 'Latency, last 5 minutes')),
                this.svgs.chart,
            ),
            h(
                'div',
                {class: 'pl-row'},
                h(
                    'button',
                    {
                        type: 'button',
                        class: 'pl-btn-ghost',
                        onclick: () => this.engine?.jumpToLive(),
                    },
                    'Jump to live',
                ),
                h(
                    'label',
                    {class: 'pl-toggle'},
                    this.ref('autosync', h('input', {type: 'checkbox'})),
                    'Auto-sync when drift exceeds',
                ),
                this.ref(
                    'autosyncSecs',
                    h('input', {
                        class: 'pl-control num pl-control--short',
                        type: 'number',
                        min: 2,
                        value: 30,
                        'aria-label': 'Seconds',
                    }),
                ),
                h('span', {class: 'pl-muted'}, 's'),
                this.ref('target', h('span', {class: 'pl-muted'})),
            ),
            h(
                'label',
                {class: 'pl-toggle'},
                this.ref('returnJump', h('input', {type: 'checkbox', checked: true})),
                'Jump to live when I come back to this tab, if drift is over the auto-sync limit',
            ),
        );
    }

    private buildAbrPanel(): HTMLElement {
        return h(
            'div',
            {},
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Rays (rendition ladder)'),
                this.ref(
                    'ladder',
                    h(
                        'div',
                        {class: 'pl-ladder'},
                        h('p', {class: 'pl-muted'}, 'Load a stream to see its rays.'),
                    ),
                ),
                h(
                    'div',
                    {class: 'pl-row'},
                    h('span', {class: 'pl-muted'}, 'Toggle rays to restrict playback:'),
                    this.ref('raysParam', h('code', {class: 'pl-raysparam'}, 'all rays')),
                    this.ref(
                        'raysReload',
                        h(
                            'button',
                            {
                                type: 'button',
                                class: 'pl-btn-ghost',
                                onclick: () => void this.reloadWithRays(),
                            },
                            'Re-sign & reload',
                        ),
                    ),
                ),
            ),
            this.ref('abrKv', h('dl', {class: 'pl-kv'})),
            this.ref('abrLog', h('div', {class: 'pl-log'})),
        );
    }

    private buildKeysPanel(): HTMLElement {
        return h(
            'div',
            {},
            this.ref('keysKv', h('dl', {class: 'pl-kv'})),
            h(
                'p',
                {class: 'pl-muted'},
                'Widevine, PlayReady and FairPlay license timing arrive with DRM playback (Phase 3).',
            ),
            this.ref('keysLog', h('div', {class: 'pl-log'})),
        );
    }

    private buildMetaPanel(): HTMLElement {
        return h(
            'div',
            {},
            this.ref('metaKv', h('dl', {class: 'pl-kv'})),
            this.ref('scteLast', h('div', {class: 'pl-scte', hidden: true})),
            this.ref('metaLog', h('div', {class: 'pl-log'})),
        );
    }

    private buildTracksPanel(): HTMLElement {
        return h(
            'div',
            {},
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Audio'),
                this.ref('audioTracks', h('div', {class: 'pl-row pl-row--flush'})),
            ),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Captions and subtitles'),
                this.ref('textTracks', h('div', {class: 'pl-row pl-row--flush'})),
                this.ref('lastCue', h('p', {class: 'pl-cue', hidden: true})),
            ),
            this.ref('cueLog', h('div', {class: 'pl-log'})),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Audio levels'),
                h(
                    'div',
                    {class: 'pl-row pl-row--flush'},
                    this.ref(
                        'meterStart',
                        h(
                            'button',
                            {
                                type: 'button',
                                class: 'pl-btn-ghost',
                                onclick: () => this.startMeter(),
                            },
                            'Start audio meter',
                        ),
                    ),
                    h(
                        'label',
                        {class: 'pl-toggle'},
                        this.ref(
                            'meterListen',
                            h('input', {type: 'checkbox', onchange: () => this.applyListen()}),
                        ),
                        'Listen',
                    ),
                ),
                this.ref('meter', h('div', {class: 'pl-meter', hidden: true})),
                h(
                    'p',
                    {class: 'pl-muted'},
                    'The meter reads the decoded audio, so it works while you are not listening. It logs silence longer than 5 s.',
                ),
            ),
        );
    }

    // --------------------------------------------------------- audio meter

    private meterState: {
        ctx: AudioContext;
        analysers: AnalyserNode[];
        gain: GainNode;
        silentSince: number | null;
        reported: boolean;
    } | null = null;

    private startMeter(): void {
        if (this.meterState) return;
        const ctx = new AudioContext();
        // A media element can feed only one source node, ever; keep it for the page's life.
        const source = ctx.createMediaElementSource(this.video);
        const splitter = ctx.createChannelSplitter(2);
        const analysers = [ctx.createAnalyser(), ctx.createAnalyser()];
        const gain = ctx.createGain();
        source.connect(splitter);
        analysers.forEach((a, i) => {
            a.fftSize = 2048;
            splitter.connect(a, i);
        });
        source.connect(gain).connect(ctx.destination);
        this.meterState = {ctx, analysers, gain, silentSince: null, reported: false};
        this.video.muted = false; // the element must output audio for the meter to see it
        this.applyListen();
        this.el<HTMLButtonElement>('meterStart').disabled = true;
        this.el('meter').hidden = false;
    }

    private applyListen(): void {
        const m = this.meterState;
        if (!m) return;
        m.gain.gain.value = this.el<HTMLInputElement>('meterListen').checked ? 1 : 0;
        void m.ctx.resume();
    }

    private renderMeter(): void {
        const m = this.meterState;
        if (!m) return;
        const buf = new Float32Array(2048);
        const levels = m.analysers.map((a) => {
            a.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const v of buf) sum += v * v;
            const rms = Math.sqrt(sum / buf.length);
            return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
        });
        this.el('meter').replaceChildren(
            ...levels.map((db, i) => {
                const pct = Number.isFinite(db)
                    ? Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
                    : 0;
                return h(
                    'div',
                    {class: 'pl-meter__row'},
                    h('span', {}, i === 0 ? 'L' : 'R'),
                    h(
                        'span',
                        {class: 'pl-meter__bar'},
                        h('span', {class: 'pl-meter__fill', style: `width:${pct.toFixed(1)}%`}),
                    ),
                    h(
                        'span',
                        {class: 'num'},
                        Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : 'silent',
                    ),
                );
            }),
        );
        const silent = !this.video.paused && levels.every((db) => !Number.isFinite(db) || db < -60);
        const now = Date.now();
        if (silent) {
            m.silentSince ??= now;
            if (!m.reported && now - m.silentSince > 5000) {
                m.reported = true;
                this.logEntry('err', 'AUDIO SILENT', 'both channels below -60 dBFS for over 5 s');
                this.mark('err', 'Audio silent');
            }
        } else {
            if (m.reported)
                this.logEntry(
                    'info',
                    'AUDIO BACK',
                    `audio after ${Math.round((now - (m.silentSince ?? now)) / 1000)} s of silence`,
                );
            m.silentSince = null;
            m.reported = false;
        }
    }

    private buildManifestPanel(): HTMLElement {
        const view = (key: 'master' | 'media', label: string) =>
            h(
                'button',
                {
                    type: 'button',
                    'aria-pressed': String(key === 'master'),
                    onclick: () => {
                        this.manifestView = key;
                        this.renderManifest();
                    },
                },
                label,
            );
        return h(
            'div',
            {},
            this.ref('manifestKv', h('dl', {class: 'pl-kv'})),
            this.ref(
                'manifestSeg',
                h(
                    'div',
                    {class: 'pl-seg pl-seg--small', role: 'group', 'aria-label': 'Playlist'},
                    view('master', 'Master'),
                    view('media', 'Media playlist'),
                ),
            ),
            this.ref(
                'manifestRaw',
                h('pre', {class: 'pl-code'}, 'Load a stream to see its master playlist.'),
            ),
        );
    }

    private buildNetworkPanel(): HTMLElement {
        return h(
            'div',
            {},
            this.ref('netKv', h('dl', {class: 'pl-kv'})),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Requests, last 30 seconds'),
                this.ref('waterfall', h('div', {class: 'pl-waterfall'})),
            ),
            this.ref('netLog', h('div', {class: 'pl-log'})),
        );
    }

    private buildLogPanel(): HTMLElement {
        return h('div', {}, this.ref('allLog', h('div', {class: 'pl-log pl-log--tall'})));
    }

    // -------------------------------------------------------------- load bar

    private syncSourceInput(): void {
        const paste = this.el<HTMLSelectElement>('source').value === PASTE;
        const url = this.el<HTMLInputElement>('url');
        url.hidden = !paste;
        if (paste) url.focus();
    }

    private syncEngineInput(): void {
        const custom = this.el<HTMLSelectElement>('engine').value === CUSTOM;
        const input = this.el<HTMLInputElement>('engineCustom');
        input.hidden = !custom;
        if (custom) input.focus();
    }

    private async loadVersions(): Promise<void> {
        this.versions = await fetchVersions(this.config.endpoints.versions).catch(() => []);
        const select = this.el<HTMLSelectElement>('engine');
        const selected = select.value;
        const seen = new Set<string>();
        const options: HTMLOptionElement[] = [];
        for (const v of this.versions) {
            seen.add(v.version);
            const tags = [
                v.version === DEFAULT_HLS_VERSION ? 'default' : '',
                v.released ?? '',
            ].filter(Boolean);
            options.push(
                h(
                    'option',
                    {value: v.version},
                    `hls.js ${v.version}${tags.length ? ` (${tags.join(', ')})` : ''}`,
                ),
            );
        }
        if (!seen.has(DEFAULT_HLS_VERSION)) {
            options.unshift(
                h(
                    'option',
                    {value: DEFAULT_HLS_VERSION},
                    `hls.js ${DEFAULT_HLS_VERSION} (default)`,
                ),
            );
        }
        select.replaceChildren(...options, h('option', {value: CUSTOM}, 'Custom version…'));
        select.value = [...select.options].some((o) => o.value === selected)
            ? selected
            : DEFAULT_HLS_VERSION;
    }

    private chosenVersion(): string {
        const select = this.el<HTMLSelectElement>('engine');
        if (select.value !== CUSTOM) return select.value;
        return this.el<HTMLInputElement>('engineCustom').value.trim() || DEFAULT_HLS_VERSION;
    }

    private start(): void {
        const {initialChannel, initialSrc, channels} = this.config;
        const source = this.el<HTMLSelectElement>('source');
        if (initialSrc) {
            source.value = PASTE;
            this.el<HTMLInputElement>('url').value = initialSrc;
            this.syncSourceInput();
            void this.loadFromForm();
        } else if (initialChannel && channels.some((c) => c.id === initialChannel)) {
            source.value = String(initialChannel);
            void this.loadFromForm();
        } else if (!channels.length) {
            source.value = PASTE;
            this.syncSourceInput();
            this.notice(
                'info',
                'No synced channels yet. Paste a URL, or add an Uplynk account and sync it.',
            );
        }
    }

    private async loadFromForm(params: Record<string, string> = {}): Promise<void> {
        const value = this.el<HTMLSelectElement>('source').value;
        this.clearNotices();
        if (value === PASTE) {
            const url = this.el<HTMLInputElement>('url').value.trim();
            if (!url) {
                this.notice('error', 'Paste a stream URL to load.');
                return;
            }
            this.updateQuery({src: url});
            await this.play({channel: null, url, expiresAt: expiryFromUrl(url)});
            return;
        }
        const channel = this.config.channels.find((c) => String(c.id) === value) ?? null;
        if (!channel) return;
        this.updateQuery({channel: String(channel.id)});
        let response: PlaybackResponse;
        try {
            response = await requestPlayback(this.config.endpoints.playback, {
                channel_id: channel.id,
                manifest: 'm3u8',
                params,
            });
        } catch (err) {
            this.notice(
                'error',
                `Could not sign a URL for ${channel.name}: ${(err as Error).message}`,
            );
            return;
        }
        const source = {channel, url: response.url, expiresAt: new Date(response.expires_at)};
        if (response.probe && !response.probe.ok) {
            this.probeFailed(response.probe, source);
            return;
        }
        await this.play(source);
    }

    private probeFailed(probe: Probe, source: Source): void {
        this.notice(
            'error',
            `Uplynk answered ${probe.error} for ${source.channel?.name ?? 'this URL'}.`,
            h(
                'button',
                {type: 'button', class: 'pl-btn-ghost', onclick: () => void this.play(source)},
                'Play anyway',
            ),
        );
    }

    private async reloadWithRays(): Promise<void> {
        if (!this.source?.channel) return;
        const rays = raysParam(
            this.enabledRays(),
            this.session.renditions.map((r) => r.ray ?? '').filter(Boolean),
        );
        await this.loadFromForm(rays ? {rays} : {});
    }

    private updateQuery(params: Record<string, string>): void {
        const query = new URLSearchParams(params).toString();
        history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
    }

    // ------------------------------------------------------------- playback

    private async play(source: Source): Promise<void> {
        this.clearNotices();
        this.engine?.destroy();
        this.engine = null;
        for (const timer of this.session.pending) clearTimeout(timer);
        this.session = new Session();
        this.source = source;
        this.renderAll();
        const version = this.chosenVersion();
        let Hls: Awaited<ReturnType<typeof loadHlsJs>>;
        try {
            Hls = await loadHlsJs(version);
        } catch {
            this.notice(
                'error',
                `Could not load hls.js ${version} from jsDelivr. Check the version number.`,
            );
            return;
        }
        if (!Hls.isSupported()) {
            this.notice(
                'error',
                'This browser does not support Media Source Extensions, which hls.js needs.',
            );
            return;
        }
        const engine = new HlsJsEngine(Hls, version);
        this.engine = engine;
        this.wire(engine);
        this.logEntry('info', 'LOAD', `${source.channel?.name ?? 'URL'} · hls.js ${version}`);
        engine.load(source.url, this.video);
    }

    private wire(engine: PlayerEngine): void {
        const s = () => this.session;
        engine.on('manifest', ({renditions, master, live}) => {
            s().renditions = renditions;
            s().master = master;
            s().live = live;
            this.renderLadder();
            this.renderManifest();
            this.renderStatus();
        });
        engine.on('rendition', ({from, to}) => {
            if (from) {
                s().switches += 1;
                const label = `RAY ${from.ray ?? '?'} → ${to.ray ?? '?'}`;
                const text = `${resLabel(from.height)} → ${resLabel(to.height)} · ${kbps(to.bitrate)}`;
                this.logEntry('abr', label, text);
                this.mark('abr', `${label} · ${text}`);
            }
            this.renderLadder();
            this.renderStatus();
        });
        engine.on('id3', ({mediaTime, frames}) => this.onId3(mediaTime, frames));
        engine.on('key', ({uri, method, ms}) => {
            const k = s().keys;
            k.count += 1;
            k.method = method;
            // Uplynk key URIs carry the ray (r=a…); the same key serves every ray.
            const id = keyIdentity(uri);
            if (k.uris.has(id)) return; // hls.js reports cached keys on every segment
            const rotated = k.uris.size > 0;
            k.uris.add(id);
            if (ms !== null && ms > 0) k.ms.push(ms);
            const label = `KEY #${k.uris.size}`;
            const timing = ms !== null && ms > 0 ? ` · ${ms} ms` : '';
            this.logEntry('key', label, `${rotated ? 'rotation · ' : ''}${method}${timing}`);
            if (rotated) this.mark('key', `${label} rotation`);
            this.renderStatus();
        });
        engine.on('segment', (seg) => {
            const n = s().segments;
            n.count += 1;
            n.ms += seg.ms;
            n.bytes += seg.bytes;
            n.last = seg;
        });
        engine.on('audio', (audio) => {
            s().audio = audio;
            this.renderTracks();
        });
        engine.on('request', (req) => {
            const list = s().requests;
            list.push(req);
            const cutoff = performance.now() - WATERFALL_MS * 2;
            while (list.length && (list[0] as RequestTiming).end < cutoff) list.shift();
        });
        engine.on('playlist', (info) => {
            s().playlist = info;
            if (this.manifestView === 'media') this.renderManifest();
        });
        engine.on('asset', (asset) => {
            const previous = s().asset;
            s().asset = asset;
            const ad = asset.kind === 'ad';
            this.logEntry(
                ad ? 'scte' : 'info',
                ad ? 'AD ASSET' : 'ASSET',
                `${asset.assetId} (${asset.kind})`,
            );
            if (ad && previous?.kind !== 'ad') this.openBreak('Uplynk ad', null);
            if (!ad && previous?.kind === 'ad') this.closeBreak();
        });
        engine.on('daterange', (range) => {
            if (range.scte35) {
                const date = engine.playingDate();
                const delay = date ? Math.max(0, range.start.getTime() - date.getTime()) : 0;
                this.onScte35(hexToBytes(range.scte35), `DATERANGE ${range.attribute}`, delay);
            } else {
                this.logEntry(
                    'info',
                    'DATERANGE',
                    `${range.id}${range.cls ? ` · ${range.cls}` : ''}`,
                );
            }
        });
        engine.on('discontinuity', ({cc}) => {
            this.logEntry('disc', 'DISCONTINUITY', `sequence ${cc}`);
            this.mark('disc', `Discontinuity ${cc}`);
        });
        engine.on('error', (err) => {
            const http = err.status !== null && err.status >= 400;
            const text = `${err.details}${err.url ? ` · ${shortUrl(err.url)}` : ''}`;
            if (!err.fatal && !http) {
                // Recoverable housekeeping from hls.js, e.g. bufferSeekOverHole
                this.logEntry('info', 'NOTICE', text);
                return;
            }
            s().errors += 1;
            if (http) s().errorsHttp += 1;
            const label = http ? `HTTP ${err.status}` : 'FATAL';
            this.logEntry('err', label, text);
            this.mark('err', `${label} · ${err.details}`);
            if (err.fatal)
                this.notice(
                    'error',
                    `Playback error: ${err.details}${err.status ? ` (HTTP ${err.status})` : ''}`,
                );
        });
    }

    private onScte35(bytes: Uint8Array, source: string, delayMs: number): void {
        let info: SpliceInfo;
        try {
            info = decodeScte35(bytes);
        } catch (err) {
            this.logEntry(
                'err',
                'SCTE-35',
                `${source} · could not decode: ${(err as Error).message} · ${toHex(bytes, 48)}`,
                'meta',
            );
            return;
        }
        const session = this.session;
        const act = () => {
            if (this.session !== session) return; // stream was reloaded
            session.scteCount += 1;
            session.lastScte = {info, at: new Date(), source};
            const text = describeScte35(info);
            this.logEntry(
                'scte',
                info.direction === 'in'
                    ? 'SCTE-35 IN'
                    : info.direction === 'out'
                      ? 'SCTE-35 OUT'
                      : 'SCTE-35',
                `${text} · ${source}`,
                'meta',
            );
            this.mark('scte', text);
            if (info.direction === 'out') this.openBreak(text, info.duration);
            if (info.direction === 'in') this.closeBreak();
            this.renderMeta();
        };
        if (delayMs > 50) session.pending.push(window.setTimeout(act, delayMs));
        else act();
    }

    private openBreak(label: string, plannedSeconds: number | null): void {
        const now = Date.now();
        const breaks = this.session.breaks;
        const open = breaks.find((b) => b.end === null);
        if (open) return; // already in a break
        breaks.push({start: now, end: null, planned: plannedSeconds, label});
    }

    /** Close breaks that ran past their planned duration without a cue-in. */
    private expireBreaks(): void {
        const now = Date.now();
        for (const b of this.session.breaks) {
            if (b.end === null && b.planned && now > b.start + b.planned * 1000 + 2000) {
                b.end = b.start + b.planned * 1000;
            }
        }
    }

    private closeBreak(): void {
        const open = this.session.breaks.find((b) => b.end === null);
        if (open) open.end = Date.now();
    }

    private onId3(mediaTime: number, frames: {id: string; data: Uint8Array}[]): void {
        const s = this.session;
        s.id3Count += 1;
        for (const frame of frames) {
            if (frame.id === 'TXXX') {
                const txxx = parseTxxx(frame.data);
                if (txxx.wallclock) s.id3.add(mediaTime, txxx.wallclock.getTime());
                this.logEntry(
                    'id3',
                    'ID3 TXXX',
                    `${txxx.description}${txxx.description ? ': ' : ''}${txxx.value}`,
                    'meta',
                );
            } else if (frame.id === 'PRIV') {
                const priv = parsePriv(frame.data);
                if (priv.isScte35) {
                    // ID3 arrives when the segment downloads; act when it plays.
                    const delay = Math.max(0, mediaTime - this.video.currentTime) * 1000;
                    this.onScte35(priv.data, `ID3 PRIV ${priv.owner}`, delay);
                } else {
                    this.logEntry(
                        'id3',
                        'ID3 PRIV',
                        `${priv.owner} · ${priv.data.length} bytes`,
                        'meta',
                    );
                }
            } else {
                this.logEntry('id3', `ID3 ${frame.id}`, `${frame.data.length} bytes`, 'meta');
            }
        }
    }

    private watchVideo(): void {
        let started = false;
        this.video.addEventListener('playing', () => {
            started = true;
            const s = this.session;
            if (s.stallStart !== null) {
                s.stalledMs += performance.now() - s.stallStart;
                s.stallStart = null;
            }
        });
        this.video.addEventListener('waiting', () => {
            if (!started || this.video.seeking) return;
            this.session.rebuffers += 1;
            this.session.stallStart = performance.now();
            this.logEntry(
                'err',
                'REBUFFER',
                `buffer empty at ${this.video.currentTime.toFixed(1)} s`,
            );
        });
        this.video.addEventListener('emptied', () => {
            started = false;
        });

        // Captions/subtitles: hls.js adds TextTracks for subtitle playlists
        // and in-band CEA-608/708, so watch the video element directly.
        const tracks = this.video.textTracks;
        const watch = (track: TextTrack) => {
            track.addEventListener('cuechange', () => this.onCue(track));
            this.renderTracks();
        };
        tracks.addEventListener('addtrack', (e) => {
            if (e.track) watch(e.track);
        });
        tracks.addEventListener('removetrack', () => this.renderTracks());
        tracks.addEventListener('change', () => this.renderTracks());

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible' || !this.engine) return;
            if (!this.el<HTMLInputElement>('returnJump').checked) return;
            const drift = this.engine.liveEdgeDrift();
            const limit = Number(this.el<HTMLInputElement>('autosyncSecs').value) || 30;
            if (drift !== null && drift > limit) {
                this.engine.jumpToLive();
                this.logEntry(
                    'info',
                    'TAB RETURN',
                    `drift ${drift.toFixed(1)} s > ${limit} s · jumped to live`,
                );
            }
        });
    }

    private onCue(track: TextTrack): void {
        if (track.mode !== 'showing' && track.mode !== 'hidden') return;
        if (!isCaptionTrack(track)) return;
        const cue = track.activeCues?.[0] as VTTCue | undefined;
        if (!cue?.text) return;
        const text = cue.text
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const last = this.el('lastCue');
        last.hidden = false;
        last.textContent = `${track.label || track.language || 'track'}: ${text}`;
        const row = h(
            'div',
            {},
            h('time', {}, clock(new Date())),
            h('b', {class: 't-info'}, track.language || track.kind),
            h('span', {class: 'pl-log__text'}, text),
        );
        prependCapped(this.el('cueLog'), row, 100);
    }

    // ----------------------------------------------------------------- tick

    private tick(): void {
        const engine = this.engine;
        if (engine && !this.video.paused) this.measure(engine);
        this.renderVitals();
        this.renderMeter();
        this.renderLatency();
        this.renderAbrKv();
        this.renderKeys();
        this.renderMeta();
        this.renderNetwork();
        this.renderStatus();
        this.expireBreaks();
        drawTimeline(
            this.svgs.timeline,
            this.session.series.points,
            this.session.timeline,
            this.session.breaks,
            WINDOW_MS,
        );
        drawLatencyChart(this.svgs.chart, this.session.series.points, WINDOW_MS);
    }

    private measure(engine: PlayerEngine): void {
        const s = this.session;
        const now = Date.now();
        const id3 = s.id3.latencyAt(this.video.currentTime, now);
        if (id3 !== null && id3 > -5) s.latency.id3.add(id3);
        const date = engine.playingDate();
        const pdt = date ? (now - date.getTime()) / 1000 : null;
        if (pdt !== null) s.latency.pdt.add(pdt);
        const drift = engine.liveEdgeDrift();
        if (drift !== null) s.latency.drift.add(drift);
        const headline = id3 ?? pdt;
        if (headline !== null) s.series.push(headline, now);

        const threshold = Number(this.el<HTMLInputElement>('autosyncSecs').value) || 30;
        if (
            this.el<HTMLInputElement>('autosync').checked &&
            drift !== null &&
            drift > threshold &&
            now - s.lastSync > 10000
        ) {
            s.lastSync = now;
            engine.jumpToLive();
            this.logEntry(
                'info',
                'AUTO-SYNC',
                `drift ${drift.toFixed(1)} s > ${threshold} s · jumped to live`,
            );
        }
    }

    /** Which latency source drives the headline numbers. */
    private headline(): {stats: RunningStats; name: string} {
        const {id3, pdt} = this.session.latency;
        return id3.count
            ? {stats: id3, name: 'ID3'}
            : {stats: pdt, name: pdt.count ? 'PDT' : 'ID3'};
    }

    // --------------------------------------------------------------- render

    private renderAll(): void {
        this.el('allLog').replaceChildren();
        this.el('abrLog').replaceChildren();
        this.el('keysLog').replaceChildren();
        this.el('metaLog').replaceChildren();
        this.el('netLog').replaceChildren();
        this.el('cueLog').replaceChildren();
        this.el('lastCue').hidden = true;
        this.renderTracks();
        this.renderLadder();
        this.renderManifest();
        this.tick();
    }

    private setVital(key: string, value: string, hint: string, state: string | null): void {
        const el = this.el(`v-${key}`);
        el.className = `pl-vital${state ? ` ${state}` : ''}`;
        (el.children[1] as HTMLElement).innerHTML = value;
        (el.children[2] as HTMLElement).textContent = hint;
    }

    private renderVitals(): void {
        const s = this.session;
        const {stats, name} = this.headline();
        const latest = stats.last;
        const band = latest === null ? null : bandFor(latest);
        this.setVital(
            'latency',
            latest === null ? '--' : `<span class="num">${secs(latest)}</span><small>s</small>`,
            latest === null
                ? this.engine
                    ? 'waiting for ID3 / PDT'
                    : ' '
                : `${band?.label} · ${name}`,
            band ? `band-${band.key}` : null,
        );
        const label = this.el('v-latency').querySelector('.pl-vital__label');
        if (label) label.textContent = `Latency · ${name}`;

        const drift = s.latency.drift.last;
        const target = this.engine?.targetLatency();
        this.setVital(
            'drift',
            drift === null ? '--' : `<span class="num">${secs(drift)}</span><small>s</small>`,
            target ? `target ${secs(target)} s` : s.live ? ' ' : 'VOD',
            drift === null ? null : target && drift > target * 2 ? 'state-warn' : 'state-good',
        );

        const buffer = bufferAhead(this.video);
        this.setVital(
            'buffer',
            buffer === null ? '--' : `<span class="num">${secs(buffer)}</span><small>s</small>`,
            'forward buffer',
            buffer === null
                ? null
                : buffer < 2
                  ? 'state-bad'
                  : buffer < 6
                    ? 'state-warn'
                    : 'state-good',
        );

        const r = this.engine?.currentRendition() ?? null;
        const rays = s.renditions.map((x) => x.ray).filter(Boolean) as string[];
        this.setVital(
            'ray',
            r ? `${r.ray ?? '?'} <small>${resLabel(r.height)}</small>` : '--',
            r ? `${kbps(r.bitrate)}bps${rays.length ? ` · rays ${rayRange(rays)}` : ''}` : ' ',
            r ? 'state-good' : null,
        );
        this.setVital(
            'rebuffers',
            `<span class="num">${s.rebuffers}</span>`,
            `${secs(stalledSeconds(s), 1)} s stalled`,
            this.engine ? (s.rebuffers ? 'state-warn' : 'state-good') : null,
        );
        const lastErr = s.log.find((e) => e.kind === 'err');
        this.setVital(
            'errors',
            `<span class="num">${s.errors}</span>`,
            lastErr ? `${lastErr.label} · ${lastErr.text}` : 'none',
            this.engine ? (s.errors ? 'state-warn' : 'state-good') : null,
        );

        this.el('hudRay').textContent = r
            ? `ray ${r.ray ?? '?'} · ${resLabel(r.height)} · ${mbps(r.bitrate)}`
            : this.engine
              ? 'loading…'
              : 'no stream';
        this.el('hudLatency').textContent = latest === null ? '' : `${secs(latest)} s behind live`;
        this.el('hudLatency').hidden = latest === null;
    }

    private renderLatency(): void {
        const {stats, name} = this.headline();
        this.el('tilesTitle').textContent = `${name} latency since load`;
        this.el('chartTitle').textContent = `${name} latency, last 5 minutes`;
        const tile = (key: string, value: number | null, hint: string) => {
            const el = this.el(`t-${key}`);
            const band = value === null || !Number.isFinite(value) ? null : bandFor(value);
            el.className = `pl-vital${band ? ` band-${band.key}` : ''}`;
            (el.children[1] as HTMLElement).innerHTML = band
                ? `<span class="num">${secs(value)}</span><small>s</small>`
                : '--';
            (el.children[2] as HTMLElement).textContent = hint;
        };
        tile('now', stats.last, stats.last === null ? ' ' : bandFor(stats.last).label);
        tile('avg', stats.average, `${stats.count} samples`);
        tile('max', stats.count ? stats.max : null, stats.maxAt ? `at ${clock(stats.maxAt)}` : ' ');
        tile('min', stats.count ? stats.min : null, stats.minAt ? `at ${clock(stats.minAt)}` : ' ');

        for (const key of ['id3', 'pdt', 'drift'] as const) {
            const st = this.session.latency[key];
            this.el(`now-${key}`).textContent = st.last === null ? '--' : `${secs(st.last)} s`;
            this.el(`range-${key}`).textContent = st.count
                ? `${secs(st.min)} / ${secs(st.average)} / ${secs(st.max)} s`
                : key === 'id3' && this.engine
                  ? 'no ID3 timestamps yet'
                  : '--';
        }
        const target = this.engine?.targetLatency();
        this.el('target').textContent = target ? `· hls.js target ${secs(target)} s` : '';
    }

    private enabledRays(): string[] {
        return this.session.renditions
            .map((r) => r.ray)
            .filter((r): r is string => !!r && !this.disabledRays.has(r));
    }

    private renderLadder(): void {
        const s = this.session;
        const ladder = this.el('ladder');
        const current = this.engine?.currentRendition() ?? null;
        if (!s.renditions.length) {
            ladder.replaceChildren(
                h(
                    'p',
                    {class: 'pl-muted'},
                    this.engine
                        ? 'Waiting for the master playlist…'
                        : 'Load a stream to see its rays.',
                ),
            );
            this.renderRaysParam();
            return;
        }
        const max = Math.max(...s.renditions.map((r) => r.bitrate), 1);
        const sorted = [...s.renditions].sort((a, b) => b.bitrate - a.bitrate);
        ladder.replaceChildren(
            ...sorted.map((r) => {
                const on = !r.ray || !this.disabledRays.has(r.ray);
                const isCurrent = current?.index === r.index;
                return h(
                    'div',
                    {class: `pl-rung${isCurrent ? ' is-current' : ''}`},
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'pl-ray',
                            'aria-pressed': String(on),
                            disabled: !r.ray || !this.source?.channel,
                            title: r.ray
                                ? `Include ray ${r.ray} in rays=`
                                : 'No ray letter in this variant URI',
                            onclick: () => {
                                if (!r.ray) return;
                                if (this.disabledRays.has(r.ray)) this.disabledRays.delete(r.ray);
                                else this.disabledRays.add(r.ray);
                                this.renderLadder();
                            },
                        },
                        r.ray ?? '·',
                    ),
                    h(
                        'span',
                        {class: 'pl-res'},
                        h('span', {}, `${resLabel(r.height)}${isCurrent ? ' ◂' : ''}`),
                        h(
                            'small',
                            {},
                            [r.fps ? `${r.fps} fps` : '', r.profile ?? r.codecs]
                                .filter(Boolean)
                                .join(' · '),
                        ),
                    ),
                    h(
                        'span',
                        {class: 'pl-bar'},
                        h('span', {style: `width:${((r.bitrate / max) * 100).toFixed(1)}%`}),
                    ),
                    h('span', {class: 'pl-kbps'}, kbps(r.bitrate)),
                );
            }),
        );
        this.renderRaysParam();
    }

    private renderRaysParam(): void {
        const all = this.session.renditions.map((r) => r.ray).filter(Boolean) as string[];
        const enabled = this.enabledRays();
        const param = raysParam(enabled, all);
        const canSign = Boolean(this.source?.channel) && all.length > 0;
        this.el('raysParam').textContent = !all.length
            ? 'no rays'
            : enabled.length === 0
              ? 'pick at least one ray'
              : param
                ? `rays=${param}`
                : 'all rays';
        const button = this.el<HTMLButtonElement>('raysReload');
        button.disabled = !canSign || enabled.length === 0;
        button.title = this.source?.channel
            ? ''
            : 'Only for synced channels; for a pasted URL add rays= on the Sign URL page';
    }

    private renderAbrKv(): void {
        const s = this.session;
        const bwe = this.engine?.bandwidthEstimate() ?? null;
        const last = s.segments.last;
        const q = this.video.getVideoPlaybackQuality?.();
        const dropped = q
            ? `${q.droppedVideoFrames} (${q.totalVideoFrames ? ((q.droppedVideoFrames / q.totalVideoFrames) * 100).toFixed(2) : '0.00'}%)`
            : '--';
        kv(this.el('abrKv'), [
            ['Estimated bandwidth', bwe ? mbps(bwe) : '--'],
            ['Ray switches', String(s.switches)],
            [
                'Last segment',
                last
                    ? `ray ${last.ray ?? '?'} · ${(last.bytes / 1e6).toFixed(2)} MB · ${last.ms} ms`
                    : '--',
            ],
            ['Dropped frames', dropped],
        ]);
    }

    private renderKeys(): void {
        const k = this.session.keys;
        const avg = k.ms.length ? Math.round(k.ms.reduce((a, b) => a + b, 0) / k.ms.length) : null;
        kv(this.el('keysKv'), [
            ['Encryption', k.method ?? (this.engine ? 'none seen' : '--')],
            ['Keys loaded', String(k.count)],
            ['Unique keys', String(k.uris.size)],
            ['Avg key load', avg === null ? '--' : `${avg} ms`],
        ]);
        this.el('count-keys').textContent = k.uris.size ? String(k.uris.size) : '';
    }

    private renderMeta(): void {
        const s = this.session;
        const open = s.breaks.find((b) => b.end === null);
        kv(this.el('metaKv'), [
            ['ID3 samples', String(s.id3Count)],
            ['SCTE-35 cues', String(s.scteCount)],
            [
                'Ad break',
                open ? `in progress · ${Math.round((Date.now() - open.start) / 1000)} s` : 'no',
            ],
            ['Asset', s.asset ? `${s.asset.kind} · ${s.asset.assetId}` : '--'],
        ]);
        const last = this.el('scteLast');
        last.hidden = !s.lastScte;
        if (s.lastScte) {
            const {info, at, source} = s.lastScte;
            last.replaceChildren(
                h('p', {class: 'pl-subhead'}, `Last SCTE-35 · ${clock(at)} · ${source}`),
                h('pre', {class: 'pl-code'}, scteDetails(info)),
            );
        }
        this.el('count-meta').textContent = s.id3Count ? String(s.id3Count) : '';
    }

    private renderTracks(): void {
        const {tracks, current} = this.session.audio;
        const audio = this.el('audioTracks');
        audio.replaceChildren(
            ...(tracks.length
                ? tracks.map((t) =>
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'pl-btn-ghost',
                              'aria-pressed': String(t.id === current),
                              onclick: () => this.engine?.setAudioTrack(t.id),
                          },
                          `${t.name || 'audio'}${t.lang ? ` (${t.lang})` : ''}${t.isDefault ? ' · default' : ''}`,
                      ),
                  )
                : [
                      h(
                          'span',
                          {class: 'pl-muted'},
                          this.engine
                              ? 'One audio track (muxed or default only).'
                              : 'Load a stream to see its tracks.',
                      ),
                  ]),
        );

        const text = [...this.video.textTracks].filter(isCaptionTrack);
        const showing = text.find((t) => t.mode === 'showing');
        const choose = (track: TextTrack | null) => {
            for (const t of text) t.mode = t === track ? 'showing' : 'disabled';
            this.renderTracks();
        };
        this.el('textTracks').replaceChildren(
            ...(text.length
                ? [
                      h(
                          'button',
                          {
                              type: 'button',
                              class: 'pl-btn-ghost',
                              'aria-pressed': String(!showing),
                              onclick: () => choose(null),
                          },
                          'Off',
                      ),
                      ...text.map((t) =>
                          h(
                              'button',
                              {
                                  type: 'button',
                                  class: 'pl-btn-ghost',
                                  'aria-pressed': String(t === showing),
                                  onclick: () => choose(t),
                              },
                              `${t.label || t.kind}${t.language ? ` (${t.language})` : ''}`,
                          ),
                      ),
                  ]
                : [
                      h(
                          'span',
                          {class: 'pl-muted'},
                          this.engine
                              ? 'No caption or subtitle tracks found yet.'
                              : 'Load a stream to see its tracks.',
                      ),
                  ]),
        );
        this.el('count-tracks').textContent =
            tracks.length + text.length ? String(tracks.length + text.length) : '';
    }

    private renderManifest(): void {
        const s = this.session;
        const rays = s.renditions.map((r) => r.ray).filter(Boolean) as string[];
        const pl = s.playlist;
        kv(this.el('manifestKv'), [
            ['Type', this.engine ? (s.live ? 'Live' : 'VOD') : '--'],
            [
                'Renditions',
                s.renditions.length
                    ? `${s.renditions.length}${rays.length ? ` · rays ${rayRange(rays)}` : ''}`
                    : '--',
            ],
            ['Container', pl ? pl.container : '--'],
            ['Target duration', pl ? `${pl.targetDuration} s` : '--'],
            ['Window', pl ? `${Math.round(pl.windowSeconds)} s · ${pl.segments} segments` : '--'],
            [
                'Media sequence',
                pl ? `${pl.firstSn.toLocaleString()} – ${pl.lastSn.toLocaleString()}` : '--',
            ],
            ['Program date-time', pl ? (pl.hasProgramDateTime ? 'yes' : 'no') : '--'],
            ['Playlist ray', pl?.ray ?? '--'],
        ]);
        const seg = this.el('manifestSeg');
        for (const b of seg.querySelectorAll('button')) {
            b.setAttribute(
                'aria-pressed',
                String((b.textContent === 'Master') === (this.manifestView === 'master')),
            );
        }
        const raw = this.el('manifestRaw');
        if (this.manifestView === 'media') {
            raw.textContent = pl?.text
                ? redactSignatures(pl.text)
                : this.engine
                  ? 'Waiting for a media playlist…'
                  : 'Load a stream to see its media playlist.';
            return;
        }
        raw.textContent = s.master
            ? redactSignatures(s.master)
            : this.engine
              ? 'Master playlist text is not available from this engine.'
              : 'Load a stream to see its master playlist.';
    }

    private renderNetwork(): void {
        const n = this.session.segments;
        kv(this.el('netKv'), [
            ['Segments loaded', String(n.count)],
            ['Avg segment load', n.count ? `${Math.round(n.ms / n.count)} ms` : '--'],
            ['Downloaded', `${(n.bytes / 1e6).toFixed(1)} MB`],
            ['HTTP errors', String(this.session.errorsHttp)],
        ]);
        const dot = this.el('count-network');
        dot.textContent = '';
        dot.className = this.session.errors ? 'pl-tab__dot' : 'pl-tab__count';
        dot.title = this.session.errors ? `${this.session.errors} errors` : '';
        this.renderWaterfall();
    }

    private renderWaterfall(): void {
        const now = performance.now();
        const from = now - WATERFALL_MS;
        const target = (this.session.playlist?.targetDuration ?? 6) * 1000;
        const rows = this.session.requests.filter((r) => r.end >= from).slice(-40);
        const pct = (t: number) => Math.max(0, ((t - from) / WATERFALL_MS) * 100);
        this.el('waterfall').replaceChildren(
            ...(rows.length
                ? rows.map((r) => {
                      const ms = Math.round(r.end - r.start);
                      const state = r.failed
                          ? 'err'
                          : r.kind === 'segment' && ms > target * 0.5
                            ? 'slow'
                            : r.kind;
                      return h(
                          'div',
                          {
                              class: 'pl-wf',
                              title: `${r.name} · ${r.status ?? ''} · ${ms} ms · ${(r.bytes / 1024).toFixed(0)} KB`,
                          },
                          h('span', {class: 'pl-wf__name'}, r.name),
                          h(
                              'span',
                              {class: 'pl-wf__track'},
                              h('span', {
                                  class: `pl-wf__bar pl-wf--${state}`,
                                  style: `left:${pct(r.start).toFixed(2)}%;width:${Math.max(0.4, pct(r.end) - pct(r.start)).toFixed(2)}%`,
                              }),
                          ),
                          h(
                              'span',
                              {class: 'pl-wf__ms'},
                              r.failed ? String(r.status ?? 'ERR') : `${ms} ms`,
                          ),
                      );
                  })
                : [
                      h(
                          'p',
                          {class: 'pl-muted'},
                          this.engine
                              ? 'Waiting for requests…'
                              : 'Load a stream to see its requests.',
                      ),
                  ]),
        );
    }

    private renderStatus(): void {
        const s = this.session;
        const chips: HTMLElement[] = [];
        if (this.engine) {
            chips.push(
                h('span', {class: `chip${s.live ? ' chip--live' : ''}`}, s.live ? 'LIVE' : 'VOD'),
            );
            chips.push(h('span', {class: 'chip'}, `hls.js ${this.engine.version}`));
            if (s.keys.method)
                chips.push(
                    h(
                        'span',
                        {class: 'chip'},
                        `${s.keys.method}${s.keys.uris.size > 1 ? ' · rotating keys' : ''}`,
                    ),
                );
            const r = this.engine.currentRendition();
            if (r?.codecs) chips.push(h('span', {class: 'chip'}, r.codecs));
            const rays = s.renditions.map((x) => x.ray).filter(Boolean) as string[];
            if (rays.length) chips.push(h('span', {class: 'chip'}, `rays ${rayRange(rays)}`));
            const exp = this.source?.expiresAt;
            if (exp) {
                const left = Math.max(0, Math.round((exp.getTime() - Date.now()) / 1000));
                chips.push(
                    h(
                        'span',
                        {class: `chip${left < 300 ? ' chip--warn' : ''}`},
                        `token expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
                    ),
                );
            }
        }
        this.el('status').replaceChildren(...chips);
    }

    // ---------------------------------------------------------- log/notices

    private logEntry(kind: LogKind, label: string, text: string, panel?: 'meta'): void {
        const entry: LogEntry = {t: new Date(), kind, label, text};
        const s = this.session;
        s.log.unshift(entry);
        if (s.log.length > LOG_LIMIT) s.log.pop();
        const row = () =>
            h(
                'div',
                {},
                h('time', {}, clock(entry.t)),
                h('b', {class: `t-${kind}`}, label),
                h('span', {class: 'pl-log__text'}, text),
            );
        if (kind !== 'id3') prependCapped(this.el('allLog'), row());
        if (kind === 'abr') prependCapped(this.el('abrLog'), row());
        if (kind === 'key') prependCapped(this.el('keysLog'), row());
        if (panel === 'meta' || kind === 'scte') prependCapped(this.el('metaLog'), row());
        if (kind === 'err') prependCapped(this.el('netLog'), row());
    }

    private mark(kind: TimelineKind, label: string): void {
        const now = Date.now();
        const tl = this.session.timeline;
        tl.push({t: now, kind, label});
        while (tl.length && (tl[0] as TimelineEvent).t < now - WINDOW_MS) tl.shift();
    }

    private notice(kind: 'error' | 'info', message: string, action?: HTMLElement): void {
        this.el('notices').append(
            h('div', {class: `flash flash--${kind} pl-notice`}, h('span', {}, message), action),
        );
    }

    private clearNotices(): void {
        this.el('notices').replaceChildren();
    }
}

// ------------------------------------------------------------------ helpers

function isCaptionTrack(track: TextTrack): boolean {
    return track.kind === 'captions' || track.kind === 'subtitles';
}

function scteDetails(info: SpliceInfo): string {
    const lines = [`command        ${info.command}`];
    if (info.eventId !== undefined) lines.push(`event id       ${info.eventId}`);
    if (info.outOfNetwork !== undefined) lines.push(`out of network ${info.outOfNetwork}`);
    if (info.spliceTime != null) lines.push(`splice time    ${info.spliceTime.toFixed(3)} s (pts)`);
    if (info.breakDuration != null)
        lines.push(
            `break duration ${info.breakDuration.toFixed(3)} s${info.autoReturn ? ' · auto return' : ''}`,
        );
    for (const seg of info.segmentations) {
        lines.push(
            `segmentation   ${seg.typeName} (0x${seg.typeId.toString(16)}) · event ${seg.eventId}`,
            ...(seg.duration ? [`  duration     ${seg.duration.toFixed(3)} s`] : []),
            ...(seg.upid
                ? [`  upid         type 0x${seg.upidType.toString(16)} · ${seg.upid}`]
                : []),
            `  segment      ${seg.segmentNum} of ${seg.segmentsExpected}`,
        );
    }
    return lines.join('\n');
}

function kv(el: HTMLElement, rows: [string, string][]): void {
    el.replaceChildren(
        ...rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {title: v}, v))),
    );
}

function prependCapped(el: HTMLElement, row: HTMLElement, cap = 200): void {
    el.prepend(row);
    while (el.childElementCount > cap) el.lastElementChild?.remove();
}

function bufferAhead(video: HTMLVideoElement): number | null {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t + 0.1 && t <= video.buffered.end(i))
            return video.buffered.end(i) - t;
    }
    return video.buffered.length ? 0 : null;
}

function stalledSeconds(s: Session): number {
    const ongoing = s.stallStart === null ? 0 : performance.now() - s.stallStart;
    return (s.stalledMs + ongoing) / 1000;
}

function rayRange(rays: string[]): string {
    const sorted = [...new Set(rays)].sort();
    return sorted.length > 2 ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ');
}

function expiryFromUrl(url: string): Date | null {
    try {
        const exp = new URL(url).searchParams.get('exp');
        return exp ? new Date(Number(exp) * 1000) : null;
    } catch {
        return null;
    }
}

function shortUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.host}${u.pathname.split('/').slice(-2).join('/') ? `/…/${u.pathname.split('/').slice(-2).join('/')}` : ''}`;
    } catch {
        return url.slice(0, 80);
    }
}

/** A key URI without its per-ray `r=` parameter. */
export function keyIdentity(uri: string): string {
    try {
        const u = new URL(uri);
        u.searchParams.delete('r');
        return u.toString();
    } catch {
        return uri;
    }
}

/** Hide token signatures in the master text shown on screen. */
export function redactSignatures(text: string): string {
    return text.replace(/([?&](?:sig|pbs)=)[^&\s"]+/g, '$1…');
}
