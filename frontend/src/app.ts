// The player page: load bar, video + vitals + timeline, tabbed inspector.
// Engine-agnostic: everything here talks to a PlayerEngine.

import {
    type EngineVersion,
    fetchSlicer,
    fetchVersions,
    type PlaybackResponse,
    type Probe,
    requestPlayback,
    type SavedSession,
    saveRecording,
} from './api';
import type {ChannelOption, PlayerConfig} from './config';
import {DashJsEngine, DEFAULT_DASHJS_VERSION, loadDashJs} from './engines/dashjs';
import {DEFAULT_HLS_VERSION, HlsJsEngine, loadHlsJs} from './engines/hlsjs';
import {NATIVE_VERSION, NativeEngine, nativeHlsSupported} from './engines/native';
import {DEFAULT_SHAKA_VERSION, loadShaka, ShakaEngine} from './engines/shaka';
import type {
    AudioTrack,
    DrmConfig,
    EngineEvents,
    MediaPlaylistInfo,
    PlayerEngine,
    Rendition,
    RequestTiming,
} from './engines/types';
import {BANDS, bandFor} from './lib/bands';
import {
    CLOCK_LABELS,
    type ClockInfo,
    clockFor,
    DELAY_CHOICES,
    hlsStart,
    parseDelay,
} from './lib/clock';
import {type CmcdConfig, cmcdFromUrl, contentIdFor, describeCmcd, newSessionId} from './lib/cmcd';
import type {PaneSnapshot} from './lib/compare';
import {isVersion, parseView, type View, viewQuery} from './lib/deeplink';
import {
    mpdAdAssets,
    parsePriv,
    parseTxxx,
    parseUplynkSlice,
    toHex,
    type UplynkSlice,
} from './lib/id3';
import {Id3Clock} from './lib/latency';
import {raysParam} from './lib/rays';
import {
    capPush,
    LIMITS,
    RECORDING_VERSION,
    type Recording,
    RequestTally,
    redact,
    redactDeep,
    stripQuery,
    summarize,
} from './lib/recording';
import {decodeScte35, describeScte35, hexToBytes, type SpliceInfo} from './lib/scte35';
import {describeSlicerWallclock, id3Reason, type SlicerSettings} from './lib/slicer';
import {type Point, RunningStats, Series} from './lib/stats';
import {fromResourceTiming, requestDetail, requestKey, requestState} from './lib/waterfall';
import {
    type AdBreak,
    drawLatencyChart,
    drawTimeline,
    type TimelineEvent,
    type TimelineKind,
} from './ui/charts';
import {buildCompatPanel} from './ui/compat';
import {clock, h, kbps, mbps, resLabel, secs} from './ui/dom';

const WINDOW_MS = 5 * 60 * 1000;
const LOG_LIMIT = 300;
const CUSTOM = '__custom__';
const PASTE = '__paste__';
const WATERFALL_MS = 30 * 1000;
const MAX_LATENCY_S = 6 * 3600;

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
    drm: DrmConfig | null;
    /** What program dates mean for this URL (see lib/clock.ts). */
    clock: ClockInfo;
}

type Format = 'm3u8' | 'mpd';
type EngineName = 'hls.js' | 'shaka-player' | 'dashjs' | 'native';
/** Engines whose versions come from npm (native has none). */
type NpmEngine = Exclude<EngineName, 'native'>;

const ENGINE_LABELS: Record<EngineName, string> = {
    'hls.js': 'hls.js',
    'shaka-player': 'Shaka',
    dashjs: 'dash.js',
    native: 'Native',
};
const DEFAULT_VERSIONS: Record<EngineName, string> = {
    'hls.js': DEFAULT_HLS_VERSION,
    'shaka-player': DEFAULT_SHAKA_VERSION,
    dashjs: DEFAULT_DASHJS_VERSION,
    native: NATIVE_VERSION,
};
/** What each engine can play. */
const ENGINE_FORMATS: Record<EngineName, Format[]> = {
    'hls.js': ['m3u8'],
    'shaka-player': ['m3u8', 'mpd'],
    dashjs: ['mpd'],
    native: ['m3u8'],
};
const KEY_SYSTEMS = {
    wv: 'com.widevine.alpha',
    pr: 'com.microsoft.playready',
    fps: 'com.apple.fps',
} as const;
type DrmChoice = keyof typeof KEY_SYSTEMS;
const KEY_SYSTEM_NAMES: Record<string, string> = {
    'com.widevine.alpha': 'Widevine',
    'com.microsoft.playready': 'PlayReady',
    'com.apple.fps': 'FairPlay',
    'com.apple.fps.1_0': 'FairPlay (WebKit legacy EME)',
};

/** Everything measured for one loaded stream; replaced on each load. */
class Session {
    startedAt = Date.now();
    id3 = new Id3Clock();
    /** The whole session, for recordings (the live views keep five minutes). */
    history = {
        latency: [] as Point[],
        drift: [] as Point[],
        events: [] as TimelineEvent[],
        log: [] as LogEntry[],
        requests: [] as RequestTiming[],
        tally: new RequestTally(),
    };
    latency = {id3: new RunningStats(), pdt: new RunningStats(), drift: new RunningStats()};
    series = new Series(WINDOW_MS);
    driftSeries = new Series(WINDOW_MS);
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
    /** ID3 frames by kind (TXXX description or PRIV owner), and how many carried a wallclock. */
    id3Frames = new Map<string, number>();
    id3Wallclocks = 0;
    /** DASH: prft boxes read from video segments (they feed the same clock as ID3). */
    prftCount = 0;
    prftType: string | null = null;
    /** csl-slicer-console's view of the channel's slicer; null until it answers. */
    slicer: SlicerSettings | null = null;
    scteCount = 0;
    lastSync = 0;
    breaks: AdBreak[] = [];
    lastScte: {info: SpliceInfo; at: Date; source: string} | null = null;
    requests: RequestTiming[] = [];
    playlist: MediaPlaylistInfo | null = null;
    audio: {tracks: AudioTrack[]; current: number} = {tracks: [], current: -1};
    asset: {assetId: string; kind: string} | null = null;
    /** DASH: the slice on screen, from the asset TXXX in each segment's ID3. */
    slice: UplynkSlice | null = null;
    pending: number[] = []; // timers to cancel on reload
    /** performance.now() when the engine was given the URL, and load → first frame. */
    loadAt: number | null = null;
    startupMs: number | null = null;
    cmcd: CmcdConfig | null = null;
    /** Requests seen carrying CMCD, and the last one's keys (from Resource Timing). */
    cmcdSent = {count: 0, last: null as {t: number; keys: Record<string, string>} | null};
    licenses: {count: number; failed: number; ms: number[]; last: EngineEvents['license'] | null} =
        {
            count: 0,
            failed: 0,
            ms: [],
            last: null,
        };
    keyStatuses: Record<string, string> = {};
    fairplay = false;
    fairplayWarned = false;
}

export class PlayerApp {
    private engine: PlayerEngine | null = null;
    private session = new Session();
    private source: Source | null = null;
    /** DRM → Widevine was chosen for a DRM channel, not by the user. */
    private autoDrm = false;
    private versions: Record<NpmEngine, EngineVersion[]> = {
        'hls.js': [],
        'shaka-player': [],
        dashjs: [],
    };
    private disabledRays = new Set<string>();
    private manifestView: 'master' | 'media' = 'master';
    /** The waterfall request whose detail is shown (requestKey), kept across redraws. */
    private wfSelected: {key: string; req: RequestTiming} | null = null;
    private loadToken = 0;
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
        this.watchCmcd();
        // Resource Timing keeps 250 entries by default; the waterfall looks up recent ones.
        performance.setResourceTimingBufferSize?.(1000);
        performance.addEventListener?.('resourcetimingbufferfull', () =>
            performance.clearResourceTimings(),
        );
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
            ...(this.config.embed ? [] : [this.ref('compat', buildCompatPanel())]),
            h(
                'div',
                {class: 'pl-status', 'aria-label': 'Stream properties'},
                // Chips are redrawn every second; the slicer link stays put so clicks land.
                this.ref('status', h('span', {class: 'pl-status__chips'})),
                this.ref(
                    'slicerLink',
                    h('a', {
                        class: 'chip chip--link',
                        target: '_blank',
                        rel: 'noopener',
                        hidden: true,
                    }),
                ),
            ),
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
                            h('span', {class: 'pl-muted'}, 'seconds behind live · events below'),
                        ),
                        this.svgs.timeline,
                        h(
                            'div',
                            {class: 'pl-legend'},
                            h(
                                'span',
                                {},
                                h('i', {
                                    class: 'pl-legend__line',
                                    style: 'background:var(--accent)',
                                }),
                                'Latency',
                            ),
                            h(
                                'span',
                                {},
                                h('i', {class: 'pl-legend__line pl-legend__line--dashed'}),
                                'Live-edge drift',
                            ),
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
                        ...channels.map((c) => h('option', {value: String(c.id)}, channelLabel(c))),
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
                ...this.engineOptions(),
            ),
        );
        const format = (value: Format, label: string) =>
            h(
                'button',
                {
                    type: 'button',
                    'data-format': value,
                    'aria-pressed': String(value === 'm3u8'),
                    onclick: () => this.setFormat(value),
                },
                label,
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
                this.ref(
                    'format',
                    h(
                        'div',
                        {class: 'pl-seg', role: 'group', 'aria-labelledby': 'pl-format-label'},
                        format('m3u8', 'HLS'),
                        format('mpd', 'DASH'),
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
                        placeholder: 'exact version, e.g. 1.6.15',
                        hidden: true,
                        'aria-label': 'Engine version',
                        pattern: '\\d+\\.\\d+\\.\\d+(-[\\w.]+)?',
                    }),
                ),
            ),
            h(
                'div',
                {class: 'pl-field'},
                h('label', {for: 'pl-drm'}, 'DRM'),
                this.ref(
                    'drm',
                    h(
                        'select',
                        {
                            id: 'pl-drm',
                            class: 'pl-control',
                            onchange: () => {
                                this.autoDrm = false; // the user's choice sticks
                                this.syncDrm();
                            },
                        },
                        h('option', {value: ''}, 'None'),
                        h('option', {value: 'wv'}, 'Widevine (DASH)'),
                        h('option', {value: 'pr'}, 'PlayReady (DASH)'),
                        fairplaySupported()
                            ? h('option', {value: 'fps'}, 'FairPlay (HLS, Native)')
                            : h('option', {value: 'fps', disabled: true}, 'FairPlay (Safari only)'),
                    ),
                ),
            ),
            h(
                'div',
                {class: 'pl-field'},
                h('label', {for: 'pl-delay'}, 'Delay'),
                this.ref(
                    'delay',
                    h(
                        'select',
                        {
                            id: 'pl-delay',
                            class: 'pl-control',
                            title: "Uplynk's delay= signing param: seconds behind live. Default is the channel's latency profile (60 s unless set). Synced channels only",
                        },
                        h('option', {value: ''}, 'Default'),
                        ...DELAY_CHOICES.map((d) => h('option', {value: String(d)}, `${d} s`)),
                    ),
                ),
            ),
            h(
                'div',
                {class: 'pl-field pl-field--check'},
                h('label', {for: 'pl-cmcd'}, 'CMCD'),
                this.ref(
                    'cmcd',
                    h('input', {
                        id: 'pl-cmcd',
                        type: 'checkbox',
                        title: 'Send CMCD (CTA-5004) as a CMCD= query param on every request, so CDN logs can be matched by session id. Takes effect on the next load. Not in the native engine',
                    }),
                ),
            ),
            h(
                'div',
                {class: 'pl-field pl-field--actions'},
                h('button', {class: 'pl-btn-primary', type: 'submit'}, 'Load'),
                // In a compare pane the compare page's own link covers both views.
                ...(this.config.embed
                    ? []
                    : [
                          h(
                              'button',
                              {
                                  class: 'pl-btn-ghost',
                                  type: 'button',
                                  title: 'Copy a link to this view: source, format, engine and version, DRM, rays and tab',
                                  onclick: (e: Event) =>
                                      void this.copyLink(e.currentTarget as HTMLButtonElement),
                              },
                              'Copy link',
                          ),
                      ]),
                h(
                    'button',
                    {
                        class: 'pl-btn-ghost',
                        type: 'button',
                        title: 'Keep what this load measured on the server, with a link to replay it',
                        onclick: (e: Event) =>
                            void this.saveSession(e.currentTarget as HTMLButtonElement),
                    },
                    'Save session',
                ),
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
                                'Encoder wallclock',
                                'Encoder time in the segment (ID3 TXXX: HLS in-segment, DASH in emsg; or a DASH prft box) → now, at the playhead',
                            ),
                            row(
                                'pdt',
                                'Program date-time',
                                '#EXT-X-PROGRAM-DATE-TIME (DASH: the MPD clock) at the playhead → now',
                            ),
                            row('drift', 'Live-edge drift', 'Playhead → live edge of the playlist'),
                        ),
                    ),
                ),
            ),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'Clock'),
                h(
                    'div',
                    {class: 'pl-table-wrap'},
                    h(
                        'table',
                        {class: 'pl-defs'},
                        h(
                            'tbody',
                            {},
                            ...(
                                [
                                    ['clock', 'Program dates'],
                                    ['delay', 'Uplynk delay'],
                                    ['start', 'Start position'],
                                    ['age', 'Session'],
                                ] as const
                            ).map(([key, name]) =>
                                h(
                                    'tr',
                                    {},
                                    h('td', {}, name),
                                    this.ref(`clock-${key}`, h('td', {}, '--')),
                                ),
                            ),
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
            this.ref('drmKv', h('dl', {class: 'pl-kv', hidden: true})),
            this.ref('keyStatuses', h('div', {class: 'pl-keystatus', hidden: true})),
            this.ref('keysKv', h('dl', {class: 'pl-kv'})),
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
                h(
                    'p',
                    {class: 'pl-subhead'},
                    'Requests, last 30 seconds',
                    this.ref(
                        'wfHint',
                        h('span', {class: 'pl-muted pl-wf-hint'}, ' · click one for detail'),
                    ),
                ),
                this.ref(
                    'waterfall',
                    h('div', {class: 'pl-waterfall', role: 'list', 'aria-label': 'Requests'}),
                ),
                this.ref('wfDetail', h('div', {class: 'pl-wf-detail', hidden: true})),
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
        // delay= is signed in; a pasted URL's signature is fixed.
        this.el<HTMLSelectElement>('delay').disabled = paste;
        this.applyChannelDrm(paste ? null : this.selectedChannel());
    }

    private selectedChannel(): ChannelOption | null {
        const value = this.el<HTMLSelectElement>('source').value;
        return this.config.channels.find((c) => String(c.id) === value) ?? null;
    }

    /**
     * Studio DRM channels play as FairPlay (HLS, Native) in Safari and as
     * DASH + Widevine elsewhere. Set that for DRM channels and undo it when
     * moving to a clear one, unless the user picked the DRM setting themselves.
     */
    private applyChannelDrm(channel: ChannelOption | null): void {
        if (channel?.encryption === 'drm') {
            if (this.drm()) return;
            this.el<HTMLSelectElement>('drm').value = fairplaySupported() ? 'fps' : 'wv';
            this.syncDrm();
            this.autoDrm = true;
        } else if (this.autoDrm) {
            this.el<HTMLSelectElement>('drm').value = '';
            this.setFormat('m3u8');
            this.selectEngine('hls.js');
            this.autoDrm = false;
        }
    }

    /** Remember a probe's verdict for this page and relabel the picker. */
    private noteEncryption(channel: ChannelOption, encryption: string): void {
        channel.encryption = encryption;
        const option = this.el<HTMLSelectElement>('source').querySelector<HTMLOptionElement>(
            `option[value="${channel.id}"]`,
        );
        if (option) option.textContent = channelLabel(channel);
    }

    private syncEngineInput(): void {
        const custom = this.el<HTMLSelectElement>('engine').value.endsWith(`@${CUSTOM}`);
        const input = this.el<HTMLInputElement>('engineCustom');
        input.hidden = !custom;
        if (custom) input.focus();
        // FairPlay plays in the Native engine only.
        if (this.drm() === 'fps' && this.chosenEngine().engine !== 'native')
            this.el<HTMLSelectElement>('drm').value = '';
        // Keep the format to one the engine plays: hls.js/native → HLS, dash.js → DASH.
        const formats = ENGINE_FORMATS[this.chosenEngine().engine];
        if (!formats.includes(this.format())) this.setFormat(formats[0] as Format);
    }

    private engineOptions(): HTMLElement[] {
        const group = (engine: NpmEngine, label: string, pinned: string) => {
            const list = this.versions[engine];
            const versions = list.some((v) => v.version === pinned)
                ? list
                : [{version: pinned, released: null, notes_url: ''}, ...list];
            return h(
                'optgroup',
                {label},
                ...versions.map((v) => {
                    const tags = [v.version === pinned ? 'default' : '', v.released ?? ''].filter(
                        Boolean,
                    );
                    return h(
                        'option',
                        {value: `${engine}@${v.version}`},
                        `${ENGINE_LABELS[engine]} ${v.version}${tags.length ? ` (${tags.join(', ')})` : ''}`,
                    );
                }),
                h(
                    'option',
                    {value: `${engine}@${CUSTOM}`},
                    `${ENGINE_LABELS[engine]} custom version…`,
                ),
            );
        };
        return [
            group('hls.js', 'hls.js (HLS)', DEFAULT_HLS_VERSION),
            group('shaka-player', 'Shaka Player (DASH, HLS, DRM)', DEFAULT_SHAKA_VERSION),
            group('dashjs', 'dash.js (DASH, DRM)', DEFAULT_DASHJS_VERSION),
            ...(nativeHlsSupported()
                ? [
                      h(
                          'optgroup',
                          {label: 'Browser'},
                          h(
                              'option',
                              {value: `native@${NATIVE_VERSION}`},
                              'Native <video> HLS (this browser)',
                          ),
                      ),
                  ]
                : []),
        ];
    }

    private async loadVersions(): Promise<void> {
        const endpoints = this.config.endpoints.versions;
        const [hls, shaka, dash] = await Promise.all([
            fetchVersions(endpoints['hls.js'] ?? '').catch(() => []),
            fetchVersions(endpoints['shaka-player'] ?? '').catch(() => []),
            fetchVersions(endpoints.dashjs ?? '').catch(() => []),
        ]);
        this.versions = {'hls.js': hls, 'shaka-player': shaka, dashjs: dash};
        const select = this.el<HTMLSelectElement>('engine');
        const {engine, version} = this.chosenEngine();
        const selected = select.value;
        select.replaceChildren(...this.engineOptions());
        const has = (value: string) => [...select.options].some((o) => o.value === value);
        // A custom version that turns out to be on the menu (e.g. from a link) becomes that entry.
        const listed = `${engine}@${version}`;
        select.value =
            selected.endsWith(`@${CUSTOM}`) && has(listed)
                ? listed
                : has(selected)
                  ? selected
                  : `hls.js@${DEFAULT_HLS_VERSION}`;
        this.el<HTMLInputElement>('engineCustom').hidden = !select.value.endsWith(`@${CUSTOM}`);
    }

    private chosenEngine(): {engine: EngineName; version: string} {
        const [engine, version] = this.el<HTMLSelectElement>('engine').value.split('@') as [
            EngineName,
            string,
        ];
        if (version !== CUSTOM) return {engine, version};
        // The version goes into a jsDelivr URL: exact releases only.
        const typed = this.el<HTMLInputElement>('engineCustom').value.trim();
        return {engine, version: isVersion(typed) ? typed : DEFAULT_VERSIONS[engine]};
    }

    private selectEngine(engine: EngineName): void {
        if (this.chosenEngine().engine === engine) return;
        this.el<HTMLSelectElement>('engine').value = `${engine}@${DEFAULT_VERSIONS[engine]}`;
        this.syncEngineInput();
    }

    private format(): Format {
        const pressed = this.el('format').querySelector('[aria-pressed="true"]');
        return (pressed?.getAttribute('data-format') as Format) ?? 'm3u8';
    }

    private setFormat(value: Format): void {
        for (const b of this.el('format').querySelectorAll('button')) {
            b.setAttribute('aria-pressed', String(b.getAttribute('data-format') === value));
        }
        // Keep the engine to one that plays the format (Shaka plays both).
        const engine = this.chosenEngine().engine;
        if (!ENGINE_FORMATS[engine].includes(value))
            this.selectEngine(value === 'mpd' ? 'shaka-player' : 'hls.js');
        // Widevine/PlayReady are DASH only, FairPlay HLS only.
        const drm = this.drm();
        if (drm && (value === 'm3u8') !== (drm === 'fps'))
            this.el<HTMLSelectElement>('drm').value = '';
    }

    private drm(): DrmChoice | null {
        const value = this.el<HTMLSelectElement>('drm').value;
        return value in KEY_SYSTEMS ? (value as DrmChoice) : null;
    }

    private syncDrm(): void {
        const drm = this.drm();
        if (drm === 'fps') {
            // FairPlay: HLS in the browser's own player (EME).
            this.selectEngine('native');
            this.setFormat('m3u8');
        } else if (drm) {
            this.setFormat('mpd'); // Widevine/PlayReady need DASH and Shaka or dash.js
        }
    }

    private start(): void {
        const {initialChannel, initialSrc, channels} = this.config;
        const source = this.el<HTMLSelectElement>('source');
        const view = parseView(location.search);
        this.applyView(view);
        if (initialSrc) {
            source.value = PASTE;
            this.el<HTMLInputElement>('url').value = initialSrc;
            this.syncSourceInput();
            void this.loadFromForm();
        } else if (initialChannel && channels.some((c) => c.id === initialChannel)) {
            source.value = String(initialChannel);
            this.applyChannelDrm(this.selectedChannel());
            void this.loadFromForm(view.rays ? {rays: view.rays} : {});
        } else if (!channels.length) {
            source.value = PASTE;
            this.syncSourceInput();
            this.notice(
                'info',
                'No synced channels yet. Paste a URL, or add an Uplynk account and sync it.',
            );
        }
    }

    /** Set the load bar from a deep link: engine, then format, then DRM (each may adjust the others). */
    private applyView(view: View): void {
        if (view.engine) {
            const select = this.el<HTMLSelectElement>('engine');
            const version = view.version ?? DEFAULT_VERSIONS[view.engine];
            const listed = `${view.engine}@${version}`;
            if ([...select.options].some((o) => o.value === listed)) {
                select.value = listed;
            } else {
                // Not on the menu yet (versions load later): use it as a custom version.
                select.value = `${view.engine}@${CUSTOM}`;
                this.el<HTMLInputElement>('engineCustom').value = version;
            }
            this.syncEngineInput();
            this.el<HTMLInputElement>('engineCustom').blur();
        }
        if (view.format && ENGINE_FORMATS[this.chosenEngine().engine].includes(view.format))
            this.setFormat(view.format);
        // A FairPlay link opened outside Safari falls back to the channel's default.
        if (view.drm && (view.drm !== 'fps' || fairplaySupported())) {
            this.el<HTMLSelectElement>('drm').value = view.drm;
            this.syncDrm();
            this.autoDrm = false;
        }
        if (view.delay !== undefined) this.setDelay(view.delay);
        if (view.cmcd) this.el<HTMLInputElement>('cmcd').checked = true;
    }

    /** Select a delay, adding it to the menu if a link asked for an unlisted one. */
    private setDelay(delay: number): void {
        const select = this.el<HTMLSelectElement>('delay');
        if (![...select.options].some((o) => o.value === String(delay)))
            select.append(h('option', {value: String(delay)}, `${delay} s`));
        select.value = String(delay);
    }

    private delay(): number | null {
        return parseDelay(this.el<HTMLSelectElement>('delay').value);
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
            // A pasted .mpd plays as DASH whatever the toggle says.
            if (/\.mpd(\?|$)/i.test(url) && this.format() !== 'mpd') this.setFormat('mpd');
            this.updateQuery({src: url});
            // Pasted URLs have no Preplay response; use Uplynk's default license host.
            const drm = this.drm();
            if (drm === 'fps') {
                this.notice(
                    'error',
                    'FairPlay needs a synced channel: its certificate URL comes from Preplay. Pick the channel instead of pasting a URL.',
                );
                return;
            }
            await this.play({
                channel: null,
                url,
                expiresAt: expiryFromUrl(url),
                drm: drm
                    ? {keySystem: KEY_SYSTEMS[drm], licenseUrl: defaultLicenseUrl(url, drm)}
                    : null,
                clock: clockFor(this.format(), url, null),
            });
            return;
        }
        const channel = this.config.channels.find((c) => String(c.id) === value) ?? null;
        if (!channel) return;
        const drm = this.drm();
        const manifest = this.format();
        const delay = this.delay();
        this.updateQuery({channel: channel.id, rays: params.rays, delay: delay ?? undefined});
        // Encoder-time program dates make HLS latency real; DASH ignores pdts
        // (the server measures its clock offset instead).
        const signed: Record<string, string> = {
            ...params,
            ...(manifest === 'm3u8' ? {pdts: 'latency'} : {}),
            ...(delay !== null ? {delay: String(delay)} : {}),
        };
        let response: PlaybackResponse;
        try {
            response = await requestPlayback(this.config.endpoints.playback, {
                channel_id: channel.id,
                manifest,
                params: signed,
                // DRM needs Preplay: it returns the session URL and license servers.
                ...(drm ? {mode: 'preplay' as const, drm} : {}),
            });
        } catch (err) {
            this.notice(
                'error',
                `Could not sign a URL for ${channel.name}: ${(err as Error).message}`,
            );
            return;
        }
        const encryption = response.probe?.encryption;
        if (encryption) {
            const learned = encryption === 'drm' && channel.encryption !== 'drm';
            this.noteEncryption(channel, encryption);
            if (learned && !drm) {
                // First time we've seen this channel's FairPlay keys: replay with DRM.
                this.applyChannelDrm(channel);
                await this.loadFromForm(params);
                this.notice(
                    'info',
                    fairplaySupported()
                        ? `${channel.name} uses Studio DRM, so it is playing with FairPlay in the Native engine.`
                        : `${channel.name} uses Studio DRM (FairPlay over HLS, Safari only), so it is playing as DASH with Widevine.`,
                );
                return;
            }
        }
        let drmConfig: DrmConfig | null = null;
        if (drm === 'fps') {
            const certificateUrl = response.drm_config?.fairplayCertificateURL;
            if (!certificateUrl) {
                this.notice(
                    'error',
                    `Preplay returned no FairPlay certificate URL for ${channel.name}. Is Studio DRM with FairPlay enabled on this channel?`,
                );
                return;
            }
            drmConfig = {keySystem: KEY_SYSTEMS.fps, certificateUrl};
        } else if (drm) {
            const licenseUrl =
                drm === 'wv'
                    ? response.drm_config?.widevineLicenseURL
                    : response.drm_config?.playreadyLicenseURL;
            if (!licenseUrl) {
                this.notice(
                    'error',
                    `Preplay returned no ${drm === 'wv' ? 'Widevine' : 'PlayReady'} license URL for ${channel.name}. Is Studio DRM enabled on this channel?`,
                );
                return;
            }
            drmConfig = {keySystem: KEY_SYSTEMS[drm], licenseUrl};
        }
        const source: Source = {
            channel,
            url: response.url,
            expiresAt: new Date(response.expires_at),
            drm: drmConfig,
            clock: clockFor(manifest, response.url, response.clock, delay, signed.pdts ?? null),
        };
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

    /** Write what is about to play into the address bar, so the page can be shared or reloaded. */
    private updateQuery(source: {
        src?: string;
        channel?: number;
        rays?: string;
        delay?: number;
    }): void {
        const {engine, version} = this.chosenEngine();
        const query = viewQuery({
            ...source,
            cmcd: this.el<HTMLInputElement>('cmcd').checked || undefined,
            format: this.format(),
            engine,
            version: engine === 'native' ? undefined : version,
            // DRM the player chose for a DRM channel is chosen again on open.
            drm: this.autoDrm ? undefined : (this.drm() ?? undefined),
        });
        history.replaceState(null, '', `${location.pathname}?${query}${location.hash}`);
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

    /** Everything this load measured, redacted, for POST /api/sessions. */
    private buildRecording(): Recording | null {
        const s = this.session;
        const source = this.source;
        const engine = this.engine;
        if (!source || !engine) return null;
        const t0 = performance.timeOrigin;
        const drm = engine.drmState();
        const avg = (list: number[]) =>
            list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null;
        const {name} = this.headline();
        // Only synced channels can be reopened live: a pasted URL's signature has expired.
        const query = source.channel ? location.search.replace(/^\?/, '') : '';
        const recording: Recording = {
            v: RECORDING_VERSION,
            title: source.channel?.name ?? `Pasted URL · ${pastedHost(source.url)}`,
            source: {
                channel: source.channel?.id ?? null,
                url: redact(source.url),
                format: this.format(),
                engine: engine.name,
                version: engine.version,
                drm: source.drm ? (KEY_SYSTEM_NAMES[source.drm.keySystem] ?? null) : null,
                link: query,
            },
            startedAt: s.startedAt,
            endedAt: Date.now(),
            live: s.live,
            userAgent: navigator.userAgent,
            latencyName: name,
            clock: source.clock,
            cmcd: s.cmcd,
            stats: {
                latency: summarize(this.headline().stats),
                id3: summarize(s.latency.id3),
                pdt: summarize(s.latency.pdt),
                drift: summarize(s.latency.drift),
            },
            counters: {
                switches: s.switches,
                startupMs: s.startupMs,
                rebuffers: s.rebuffers,
                stalledSeconds: Math.round(stalledSeconds(s) * 10) / 10,
                errors: s.errors,
                httpErrors: s.errorsHttp,
                segments: s.segments.count,
                segmentAvgMs: s.segments.count
                    ? Math.round(s.segments.ms / s.segments.count)
                    : null,
                megabytes: Math.round(s.segments.bytes / 1e5) / 10,
                keys: s.keys.uris.size,
                keyAvgMs: avg(s.keys.ms),
                licenses: s.licenses.count,
                licensesFailed: s.licenses.failed,
                licenseAvgMs: avg(s.licenses.ms),
                id3: s.id3Count,
                scte35: s.scteCount,
                adBreaks: s.breaks.length,
            },
            series: {latency: s.history.latency, drift: s.history.drift},
            events: s.history.events,
            breaks: s.breaks.slice(-LIMITS.breaks),
            log: s.history.log.map((e) => ({
                t: e.t.getTime(),
                kind: e.kind,
                label: e.label,
                text: e.text,
            })),
            renditions: s.renditions.map(({ray, width, height, bitrate, codecs, fps, profile}) => ({
                ray,
                width,
                height,
                bitrate,
                codecs,
                fps,
                profile,
            })),
            requestStats: s.history.tally.summary(),
            requests: s.history.requests.map((r) => ({
                kind: r.kind,
                name: shortUrlFull(r.name),
                start: Math.round(t0 + r.start),
                end: Math.round(t0 + r.end),
                status: r.status,
                bytes: r.bytes,
                failed: r.failed,
                ttfbMs: r.ttfb == null ? null : Math.round(r.ttfb - r.start),
                mediaDuration: r.mediaDuration ?? null,
                // Host and path only: the query carries tokens (redactDeep covers the rest).
                url: r.url ? shortUrlFull(r.url) : null,
            })),
            drm: drm
                ? {
                      keySystem: drm.keySystem,
                      licenseServer: stripQuery(drm.licenseServer),
                      robustness: drm.videoRobustness,
                      keyStatuses: drm.keyStatuses,
                  }
                : null,
            playlist: s.playlist
                ? Object.fromEntries(Object.entries(s.playlist).filter(([k]) => k !== 'text'))
                : null,
        };
        return redactDeep(recording);
    }

    // ------------------------------------------------- compare page (iframes)

    /** This pane's numbers for the compare page. */
    snapshot(): PaneSnapshot {
        const s = this.session;
        const engine = this.engine;
        const source = this.source;
        const {stats, name} = this.headline();
        const rendition = engine?.currentRendition() ?? null;
        const chosen = this.engineFor(source);
        return {
            title: source ? (source.channel?.name ?? pastedHost(source.url)) : null,
            engine: engine?.name ?? ENGINE_LABELS[chosen.engine],
            version: engine?.version ?? chosen.version,
            format: this.format(),
            drm: source?.drm ? (KEY_SYSTEM_NAMES[source.drm.keySystem] ?? null) : null,
            clock: source ? CLOCK_LABELS[source.clock.kind].name : null,
            delay: source?.clock.delay ?? null,
            live: s.live,
            playing: !!engine && !this.video.paused && this.video.readyState > 2,
            latencyName: name,
            latency: {
                last: stats.last,
                avg: stats.count ? stats.average : null,
                min: stats.count ? stats.min : null,
                max: stats.count ? stats.max : null,
                count: stats.count,
            },
            drift: s.latency.drift.last,
            buffer: engine ? bufferAhead(this.video) : null,
            ray: rendition?.ray ?? null,
            height: rendition?.height ?? null,
            bitrate: rendition?.bitrate ?? null,
            bandwidth: engine?.bandwidthEstimate() ?? null,
            startupMs: s.startupMs,
            rebuffers: s.rebuffers,
            stalledS: s.stalledMs / 1000,
            errors: s.errors,
            switches: s.switches,
            segmentAvgMs: s.segments.count ? Math.round(s.segments.ms / s.segments.count) : null,
            series: s.series.points,
        };
    }

    /** Save this load as a recording; null if nothing is loaded. */
    async save(): Promise<SavedSession | null> {
        const recording = this.buildRecording();
        return recording ? saveRecording(this.config.endpoints.sessions, recording) : null;
    }

    private async saveSession(button: HTMLButtonElement): Promise<void> {
        const recording = this.buildRecording();
        if (!recording) {
            this.notice('error', 'Load a stream first; there is nothing to save yet.');
            return;
        }
        button.disabled = true;
        try {
            const saved = await saveRecording(this.config.endpoints.sessions, recording);
            const url = new URL(saved.url, location.href).href;
            await navigator.clipboard?.writeText(url).catch(() => undefined);
            this.notice(
                'info',
                `Session saved (${saved.size_kb} KB, kept ${saved.retention_days ? `${saved.retention_days} days` : 'until deleted'}); link copied.`,
                h('a', {href: saved.url, target: '_blank', rel: 'noopener'}, 'Open recording'),
            );
            this.logEntry('info', 'SAVED', url);
        } catch (err) {
            this.notice('error', `Could not save the session: ${(err as Error).message}`);
        } finally {
            button.disabled = false;
        }
    }

    // ------------------------------------------------------------- playback

    private async play(source: Source): Promise<void> {
        this.clearNotices();
        const previous = this.engine;
        this.engine = null;
        this.loadToken += 1;
        const token = this.loadToken;
        // Shaka needs the old player fully detached before a new one attaches.
        await previous?.destroy();
        if (token !== this.loadToken) return; // a newer load started meanwhile
        for (const timer of this.session.pending) clearTimeout(timer);
        this.session = new Session();
        this.source = source;
        this.renderSlicerLink(source.channel);
        void this.loadSlicer(source.channel);
        this.renderAll();
        const {engine: kind, version} = this.engineFor(source);
        const drm = source.drm;
        const cenc = drm && drm.keySystem !== 'com.apple.fps' ? drm : null;
        let engine: PlayerEngine;
        try {
            if (kind === 'shaka-player') {
                const shaka = await loadShaka(version);
                if (!shaka.Player.isBrowserSupported()) {
                    this.notice(
                        'error',
                        'This browser lacks the Media Source / EME support Shaka needs.',
                    );
                    return;
                }
                engine = new ShakaEngine(shaka, version, cenc);
            } else if (kind === 'dashjs') {
                const dashjs = await loadDashJs(version);
                if (!dashjs.supportsMediaSource()) {
                    this.notice(
                        'error',
                        'This browser does not support Media Source Extensions, which dash.js needs.',
                    );
                    return;
                }
                engine = new DashJsEngine(dashjs, version, cenc);
            } else if (kind === 'native') {
                if (!nativeHlsSupported()) {
                    this.notice('error', 'This browser cannot play HLS natively; use hls.js.');
                    return;
                }
                engine = new NativeEngine(drm?.keySystem === 'com.apple.fps' ? drm : null);
            } else {
                const Hls = await loadHlsJs(version);
                if (!Hls.isSupported()) {
                    this.notice(
                        'error',
                        'This browser does not support Media Source Extensions, which hls.js needs.',
                    );
                    return;
                }
                engine = new HlsJsEngine(Hls, version);
            }
        } catch {
            this.notice(
                'error',
                `Could not load ${ENGINE_LABELS[kind]} ${version} from jsDelivr. Check the version number.`,
            );
            return;
        }
        if (token !== this.loadToken) {
            await engine.destroy();
            return;
        }
        this.engine = engine;
        // Handy from the browser console when triaging: playerEngine.drmState() etc.
        (window as unknown as {playerEngine: PlayerEngine}).playerEngine = engine;
        this.wire(engine);
        const drmText = source.drm ? ` · ${KEY_SYSTEM_NAMES[source.drm.keySystem]}` : '';
        this.logEntry(
            'info',
            'LOAD',
            `${source.channel?.name ?? 'URL'} · ${engine.name} ${version}${drmText}`,
        );
        if (engine.limits) this.logEntry('info', 'ENGINE', engine.limits);
        if (this.el<HTMLInputElement>('cmcd').checked) {
            if (kind === 'native') {
                this.logEntry('info', 'CMCD', 'not sent: the native engine has no CMCD support');
            } else {
                const cmcd = {
                    sessionId: newSessionId(),
                    contentId: contentIdFor(source.channel?.channelId ?? null, source.url),
                };
                engine.cmcd = cmcd;
                this.session.cmcd = cmcd;
                this.logEntry('info', 'CMCD', `query mode · sid ${cmcd.sessionId}`);
            }
        }
        this.session.loadAt = performance.now();
        engine.load(source.url, this.video);
    }

    /** The engine a source plays in: DRM can override the picker. */
    private engineFor(source: Source | null): {engine: EngineName; version: string} {
        if (source?.drm?.keySystem === 'com.apple.fps')
            return {engine: 'native', version: NATIVE_VERSION};
        return source?.drm ? this.drmEngine() : this.chosenEngine();
    }

    /** Widevine/PlayReady play in dash.js when it's chosen, otherwise Shaka. */
    private drmEngine(): {engine: 'shaka-player' | 'dashjs'; version: string} {
        const chosen = this.chosenEngine();
        if (chosen.engine === 'shaka-player' || chosen.engine === 'dashjs')
            return {engine: chosen.engine, version: chosen.version};
        return {engine: 'shaka-player', version: DEFAULT_SHAKA_VERSION};
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
        engine.on('license', (lic) => {
            const l = s().licenses;
            l.last = lic;
            if (lic.failed) {
                l.failed += 1;
                this.logEntry('err', 'LICENSE ✗', lic.error ?? 'license request failed');
                this.mark('err', `License failed · ${lic.error ?? ''}`);
            } else {
                l.count += 1;
                l.ms.push(lic.ms);
                this.logEntry(
                    'key',
                    'LICENSE',
                    `HTTP ${lic.status} · ${lic.ms} ms${lic.bytes ? ` · ${lic.bytes} bytes` : ''}`,
                );
                this.mark('key', `License ${lic.ms} ms`);
            }
            this.renderKeys();
        });
        engine.on('keystatus', ({statuses}) => {
            const before = s().keyStatuses;
            for (const [id, status] of Object.entries(statuses)) {
                if (before[id] !== status) {
                    const bad = status !== 'usable' && status !== 'status-pending';
                    this.logEntry(
                        bad ? 'err' : 'key',
                        'KEY STATUS',
                        `${shortKey(id)} → ${status}${KEY_STATUS_HINTS[status] ? ` · ${KEY_STATUS_HINTS[status]}` : ''}`,
                    );
                    if (bad) this.mark('err', `Key ${shortKey(id)} ${status}`);
                }
            }
            s().keyStatuses = {...statuses};
            this.renderKeys();
        });
        engine.on('prft', ({start, wallMs, type}) => {
            const session = s();
            session.id3.add(start, wallMs);
            session.prftCount += 1;
            if (session.prftType === null) {
                session.prftType = type;
                this.logEntry(
                    'id3',
                    'PRFT',
                    `segments carry prft (${type}): encoder latency from the DASH segments`,
                    'meta',
                );
            }
        });
        engine.on('emsg', ({scheme, value, bytes, preview}) => {
            this.logEntry(
                'id3',
                'EMSG',
                `${scheme}${value ? ` · ${value}` : ''} · ${bytes} bytes${preview ? ` · ${preview}` : ''}`,
                'meta',
            );
        });
        engine.on('audio', (audio) => {
            s().audio = audio;
            this.renderTracks();
        });
        engine.on('request', (req) => {
            // First byte / protocol from Resource Timing, if the host allows it.
            if (req.url && typeof performance.getEntriesByType === 'function') {
                const entry = findResourceEntry(req.url);
                Object.assign(req, fromResourceTiming(req, entry));
                // Engines that add CMCD in their loader (hls.js) report the URL without it.
                if (entry && entry.name !== req.url && entry.name.includes('CMCD='))
                    req.url = entry.name;
            }
            const list = s().requests;
            list.push(req);
            const history = s().history;
            history.tally.add(req.kind, req.end - req.start, req.bytes, req.failed);
            capPush(history.requests, req, LIMITS.requests);
            const cutoff = performance.now() - WATERFALL_MS * 2;
            while (list.length && (list[0] as RequestTiming).end < cutoff) list.shift();
        });
        engine.on('playlist', (info) => {
            s().playlist = info;
            if (info.text?.includes('com.apple.streamingkeydelivery') && !s().fairplay) {
                s().fairplay = true;
                if (!this.playingFairPlay()) this.warnFairPlay();
            }
            if (this.manifestView === 'media' || info.format === 'dash') this.renderManifest();
        });
        engine.on('asset', (asset) => this.onAsset(asset));
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
            if (s().fairplay && !this.playingFairPlay()) {
                this.warnFairPlay();
                return;
            }
            if (err.fatal)
                this.notice(
                    'error',
                    `Playback error: ${err.details}${err.status ? ` (HTTP ${err.status})` : ''}`,
                );
        });
    }

    /** True when this load decrypts FairPlay itself (Native engine + EME). */
    private playingFairPlay(): boolean {
        return this.source?.drm?.keySystem === 'com.apple.fps';
    }

    /** Studio DRM over HLS is FairPlay: Safari plays it with DRM → FairPlay, others need DASH. */
    private warnFairPlay(): void {
        if (this.session.fairplayWarned) return;
        this.session.fairplayWarned = true;
        const channel = this.source?.channel;
        const safari = fairplaySupported();
        this.notice(
            'error',
            safari
                ? 'This stream uses FairPlay DRM (Studio DRM over HLS). Play it with DRM → FairPlay, which uses the Native engine.'
                : 'This stream uses FairPlay DRM (Studio DRM over HLS), which only Safari can play. In Chrome, play it as DASH with Widevine.',
            h(
                'button',
                {type: 'button', class: 'pl-btn-ghost', onclick: () => this.showCompat()},
                'Why?',
            ),
            channel
                ? h(
                      'button',
                      {
                          type: 'button',
                          class: 'pl-btn-ghost',
                          onclick: () => {
                              this.el<HTMLSelectElement>('drm').value = safari ? 'fps' : 'wv';
                              this.syncDrm();
                              void this.loadFromForm();
                          },
                      },
                      safari ? 'Play with FairPlay' : 'Play with Widevine (DASH)',
                  )
                : undefined,
        );
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

    /** The playhead entered a new Uplynk asset. */
    private onAsset(asset: {assetId: string; kind: string}): void {
        const s = this.session;
        const previous = s.asset;
        s.asset = asset;
        const ad = asset.kind === 'ad';
        this.logEntry(
            ad ? 'scte' : 'info',
            ad ? 'AD ASSET' : 'ASSET',
            `${asset.assetId} (${asset.kind})`,
        );
        if (ad && previous?.kind !== 'ad') this.openBreak('Uplynk ad', null);
        if (!ad && previous?.kind === 'ad') this.closeBreak();
    }

    /**
     * DASH has no #UPLYNK-SEGMENT; its ID3 names asset, ray and slice instead.
     * Applied when the slice reaches the playhead; ad or not from the MPD.
     */
    private onDashSlice(mediaTime: number, slice: UplynkSlice): void {
        const session = this.session;
        const act = () => {
            if (session !== this.session) return;
            session.slice = slice;
            if (slice.assetId !== session.asset?.assetId) {
                const ads = mpdAdAssets(session.playlist?.text);
                this.onAsset({
                    assetId: slice.assetId,
                    kind: ads.has(slice.assetId) ? 'ad' : 'content',
                });
            }
        };
        const delayMs = Math.max(0, mediaTime - this.video.currentTime) * 1000;
        if (delayMs > 50) session.pending.push(window.setTimeout(act, delayMs));
        else act();
    }

    private onId3(mediaTime: number, frames: {id: string; data: Uint8Array}[]): void {
        const s = this.session;
        s.id3Count += 1;
        const tally = (kind: string) => s.id3Frames.set(kind, (s.id3Frames.get(kind) ?? 0) + 1);
        for (const frame of frames) {
            if (frame.id === 'TXXX') {
                const txxx = parseTxxx(frame.data);
                tally(`TXXX ${txxx.description || '(no description)'}`);
                if (txxx.wallclock) {
                    s.id3Wallclocks += 1;
                    s.id3.add(mediaTime, txxx.wallclock.getTime());
                }
                const slice = txxx.description ? null : parseUplynkSlice(txxx.value);
                if (slice && this.source?.clock.kind.startsWith('mpd')) {
                    this.onDashSlice(mediaTime, slice);
                }
                this.logEntry(
                    'id3',
                    'ID3 TXXX',
                    `${txxx.description}${txxx.description ? ': ' : ''}${txxx.value}`,
                    'meta',
                );
            } else if (frame.id === 'PRIV') {
                const priv = parsePriv(frame.data);
                tally(`PRIV ${priv.owner || '(no owner)'}`);
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
                tally(frame.id);
                this.logEntry('id3', `ID3 ${frame.id}`, `${frame.data.length} bytes`, 'meta');
            }
        }
    }

    /** What CMCD actually went out: every engine's requests show up in Resource Timing. */
    private watchCmcd(): void {
        if (typeof PerformanceObserver === 'undefined') return;
        new PerformanceObserver((list) => {
            const s = this.session;
            if (!s.cmcd) return;
            for (const entry of list.getEntries()) {
                const keys = entry.name.includes('CMCD=') ? cmcdFromUrl(entry.name) : null;
                if (!keys) continue;
                s.cmcdSent.count += 1;
                s.cmcdSent.last = {t: Date.now(), keys};
            }
        }).observe({type: 'resource', buffered: false});
    }

    private watchVideo(): void {
        let started = false;
        this.video.addEventListener('playing', () => {
            started = true;
            const s = this.session;
            if (s.startupMs === null && s.loadAt !== null && this.engine) {
                s.startupMs = Math.round(performance.now() - s.loadAt);
                this.logEntry('info', 'STARTUP', `first frame ${s.startupMs} ms after load`);
            }
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
            {
                latency: this.session.series.points,
                latencyLabel: `Latency (${this.headline().name})`,
                drift: this.session.driftSeries.points,
            },
            this.session.timeline,
            this.session.breaks,
            WINDOW_MS,
        );
        drawLatencyChart(this.svgs.chart, this.session.series.points, WINDOW_MS);
    }

    private measure(engine: PlayerEngine): void {
        const s = this.session;
        const now = Date.now();
        // Wall-clock latency only means something live; a VOD's dates can be
        // decades old. Ignore anything outside a sane window.
        const plausible = (v: number | null) =>
            s.live && v !== null && v > -5 && v < MAX_LATENCY_S ? v : null;
        const id3 = plausible(s.id3.latencyAt(this.video.currentTime, now));
        if (id3 !== null) s.latency.id3.add(id3);
        const date = engine.playingDate();
        // DASH: the MPD's clock runs ahead of the encoder's by the measured offset.
        const offset = this.source?.clock.offsetS ?? 0;
        const pdt = plausible(date ? (now - date.getTime()) / 1000 + offset : null);
        if (pdt !== null) s.latency.pdt.add(pdt);
        const drift = engine.liveEdgeDrift();
        if (drift !== null) s.latency.drift.add(drift);
        const headline = id3 ?? pdt;
        if (headline !== null) {
            s.series.push(headline, now);
            capPush(s.history.latency, {t: now, v: headline}, LIMITS.points);
        }
        if (drift !== null) {
            s.driftSeries.push(drift, now);
            capPush(s.history.drift, {t: now, v: drift}, LIMITS.points);
        }

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
            ? {stats: id3, name: this.session.prftCount ? 'prft' : 'ID3'}
            : {stats: pdt, name: pdt.count ? this.pdtName() : 'ID3'};
    }

    /** Short name of the program-date latency for this source's clock. */
    private pdtName(): string {
        switch (this.source?.clock.kind) {
            case 'session':
                return 'session PDT';
            case 'mpd-offset':
                return 'MPD + offset';
            case 'mpd':
                return 'MPD clock';
            default:
                return 'PDT';
        }
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
            target ? `target ${secs(target)} s` : s.live ? 'behind the live edge' : 'VOD',
            driftState(drift, target ?? null),
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
                  ? this.id3Status()
                  : '--';
        }
        const target = this.engine?.targetLatency();
        this.el('target').textContent = target ? `· hls.js target ${secs(target)} s` : '';
        this.renderClock();
    }

    private renderClock(): void {
        const source = this.source;
        const set = (key: string, text: string, title = '') => {
            const el = this.el(`clock-${key}`);
            el.textContent = text;
            el.title = title;
        };
        if (!source) {
            for (const key of ['clock', 'delay', 'start', 'age']) set(key, '--');
            return;
        }
        const c = source.clock;
        const label = CLOCK_LABELS[c.kind];
        const offset =
            c.kind === 'mpd-offset' && c.offsetS !== null
                ? ` · +${c.offsetS.toFixed(1)} s (edge ${c.edgeAgeS?.toFixed(1) ?? '?'} s old at load, matched on ${c.slice})`
                : '';
        set('clock', `${label.name}${offset}`, label.what);
        set(
            'delay',
            c.delay !== null
                ? `delay=${c.delay} s`
                : source.channel
                  ? "default: the channel's latency profile (60 s unless set)"
                  : 'not in the URL (the channel default)',
        );
        const start = hlsStart(this.session.master);
        set(
            'start',
            c.kind === 'mpd' || c.kind === 'mpd-offset'
                ? 'DASH: the engine picks (suggestedPresentationDelay)'
                : (start ?? (this.session.master ? 'no EXT-X-START (engine default)' : '--')),
        );
        const age = Math.round((Date.now() - this.session.startedAt) / 1000);
        set(
            'age',
            `loaded ${clock(new Date(this.session.startedAt))} · ${age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} ago`,
            'Default program dates are per session: a session that idles (nothing polling it) falls behind, then catches up when polled again',
        );
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
        const drm = this.engine?.drmState() ?? null;
        const l = this.session.licenses;
        const drmKv = this.el('drmKv');
        drmKv.hidden = !drm && !this.source?.drm;
        if (!drmKv.hidden) {
            const avg = l.ms.length
                ? Math.round(l.ms.reduce((a, b) => a + b, 0) / l.ms.length)
                : null;
            const keySystem = drm?.keySystem ?? this.source?.drm?.keySystem ?? null;
            kv(drmKv, [
                ['Key system', keySystem ? (KEY_SYSTEM_NAMES[keySystem] ?? keySystem) : '--'],
                [
                    'License server',
                    shortUrlFull(drm?.licenseServer ?? sourceLicenseUrl(this.source?.drm) ?? ''),
                ],
                ['Licenses', `${l.count} ok${l.failed ? ` · ${l.failed} failed` : ''}`],
                [
                    'License time',
                    avg === null
                        ? '--'
                        : `${avg} ms avg${l.last && !l.last.failed ? ` · last ${l.last.ms} ms` : ''}`,
                ],
                [
                    'Robustness',
                    drm
                        ? [drm.videoRobustness, drm.audioRobustness].filter(Boolean).join(' / ') ||
                          'default'
                        : '--',
                ],
                ['Scheme', drm?.encryptionScheme ?? '--'],
                [
                    'License expires',
                    drm?.expiration ? new Date(drm.expiration).toLocaleString() : 'no expiry',
                ],
                ['Keys', String(Object.keys(this.session.keyStatuses).length)],
            ]);
        }
        const statuses = Object.entries(this.session.keyStatuses);
        const ks = this.el('keyStatuses');
        ks.hidden = statuses.length === 0;
        ks.replaceChildren(
            h('p', {class: 'pl-subhead'}, 'Key status'),
            ...statuses.map(([id, status]) =>
                h(
                    'div',
                    {
                        class: `pl-keyrow pl-keyrow--${status === 'usable' ? 'ok' : status === 'status-pending' ? 'pending' : 'bad'}`,
                    },
                    h('code', {}, shortKey(id)),
                    h('span', {}, status),
                    h('span', {class: 'pl-muted'}, KEY_STATUS_HINTS[status] ?? ''),
                ),
            ),
        );

        const k = this.session.keys;
        const avg = k.ms.length ? Math.round(k.ms.reduce((a, b) => a + b, 0) / k.ms.length) : null;
        const kvEl = this.el('keysKv');
        kvEl.hidden = Boolean(drm) && k.count === 0;
        kv(kvEl, [
            [
                'Encryption',
                this.session.fairplay
                    ? 'FairPlay (SAMPLE-AES)'
                    : (k.method ?? (this.engine ? (drm ? 'CENC (DRM)' : 'none seen') : '--')),
            ],
            ['Keys loaded', String(k.count)],
            ['Unique keys', String(k.uris.size)],
            ['Avg key load', avg === null ? '--' : `${avg} ms`],
        ]);
        const count = drm ? l.count : k.uris.size;
        this.el('count-keys').textContent = count ? String(count) : '';
    }

    /**
     * Why there's no ID3 latency: no ID3 at all, or ID3 without a wallclock
     * (Uplynk slicers add one only with `wallclock: 1` in their config; the
     * slicer console says which, for its own slicers).
     */
    private id3Status(): string {
        const s = this.session;
        if (this.source?.clock.kind.startsWith('mpd')) {
            if (s.prftCount) return 'waiting for the playhead to reach a prft segment';
            // Uplynk DASH has no prft; its emsg carries the HLS ID3 instead.
            if (!s.id3Count) {
                return s.segments.count >= 3
                    ? `no prft or ID3 emsg in ${s.segments.count} DASH segments`
                    : 'waiting for a DASH segment';
            }
        }
        return id3Reason(s.id3Count, s.id3Wallclocks, s.slicer);
    }

    /** Ask the slicer console (through the server) whether the slicer writes the wallclock. */
    private async loadSlicer(channel: ChannelOption | null): Promise<void> {
        const endpoint = this.config.endpoints.slicer;
        if (!endpoint || !channel?.slicerId) return;
        const session = this.session;
        try {
            session.slicer = await fetchSlicer(endpoint.replace('{id}', String(channel.id)));
        } catch (e) {
            session.slicer = {
                slicer_id: channel.slicerId,
                found: false,
                wallclock: null,
                captured_at: null,
                running: null,
                error: e instanceof Error ? e.message : String(e),
            };
        }
        if (session === this.session) this.renderMeta();
    }

    private renderMeta(): void {
        const s = this.session;
        const open = s.breaks.find((b) => b.end === null);
        const kinds = [...s.id3Frames]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([kind, n]) => `${kind} ×${n}`)
            .join(' · ');
        kv(this.el('metaKv'), [
            ['ID3 samples', String(s.id3Count)],
            ['ID3 frames', kinds || '--'],
            [
                'Wallclock',
                s.id3Wallclocks
                    ? `${s.id3Wallclocks} timestamps`
                    : s.id3Count
                      ? 'none: enable wallclock: 1 on the slicer for ID3 latency'
                      : '--',
            ],
            ...(this.config.endpoints.slicer && this.source?.channel?.slicerId
                ? [['Slicer wallclock', describeSlicerWallclock(s.slicer)] as [string, string]]
                : []),
            ...(this.source?.clock.kind.startsWith('mpd')
                ? [
                      [
                          'prft',
                          s.prftCount
                              ? `${s.prftCount} segments · ${s.prftType}`
                              : s.segments.count
                                ? `none in ${s.segments.count} segments`
                                : '--',
                      ] as [string, string],
                  ]
                : []),
            ['SCTE-35 cues', String(s.scteCount)],
            [
                'Ad break',
                open ? `in progress · ${Math.round((Date.now() - open.start) / 1000)} s` : 'no',
            ],
            [
                'Asset',
                s.asset
                    ? `${s.asset.kind} · ${s.asset.assetId}${s.slice ? ` · slice ${s.slice.slice} · ray ${s.slice.ray}` : ''}`
                    : '--',
            ],
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
        const dash = pl?.format === 'dash' ? pl.dash : undefined;
        const common: [string, string][] = [
            ['Type', this.engine ? (s.live ? 'Live' : 'VOD') : '--'],
            [
                'Renditions',
                s.renditions.length
                    ? `${s.renditions.length}${rays.length ? ` · rays ${rayRange(rays)}` : ''}`
                    : '--',
            ],
        ];
        if (pl && dash) {
            kv(this.el('manifestKv'), [
                ...common,
                ['Container', pl.container === 'fMP4' ? 'fMP4 (CMAF)' : pl.container],
                ['Max segment', pl.targetDuration ? `${pl.targetDuration} s` : '--'],
                [
                    'Time-shift window',
                    pl.windowSeconds ? `${Math.round(pl.windowSeconds)} s` : '--',
                ],
                ['MPD update', dash.updatePeriod ? `every ${dash.updatePeriod} s` : 'static'],
                ['Periods', `${dash.periods}${dash.adPeriods ? ` · ${dash.adPeriods} ad` : ''}`],
                [
                    'Availability start',
                    dash.availabilityStart
                        ? new Date(dash.availabilityStart).toLocaleString()
                        : '--',
                ],
            ]);
        } else {
            kv(this.el('manifestKv'), [
                ...common,
                ['Container', pl ? pl.container : '--'],
                ['Target duration', pl ? `${pl.targetDuration} s` : '--'],
                [
                    'Window',
                    pl ? `${Math.round(pl.windowSeconds)} s · ${pl.segments} segments` : '--',
                ],
                [
                    'Media sequence',
                    pl ? `${pl.firstSn.toLocaleString()} – ${pl.lastSn.toLocaleString()}` : '--',
                ],
                ['Program date-time', pl ? (pl.hasProgramDateTime ? 'yes' : 'no') : '--'],
                ['Playlist ray', pl?.ray ?? '--'],
            ]);
        }
        // DASH has one document (the MPD); HLS has a master and media playlists.
        const seg = this.el('manifestSeg');
        seg.hidden = Boolean(dash);
        for (const b of seg.querySelectorAll('button')) {
            b.setAttribute(
                'aria-pressed',
                String((b.textContent === 'Master') === (this.manifestView === 'master')),
            );
        }
        const raw = this.el('manifestRaw');
        if (dash && pl?.text) {
            raw.textContent = redactSignatures(pl.text);
            return;
        }
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

    private cmcdRows(): [string, string][] {
        const s = this.session;
        if (!s.cmcd) return [['CMCD', 'off (tick CMCD in the load bar and reload)']];
        const last = s.cmcdSent.last;
        return [
            ['CMCD session', s.cmcd.sessionId],
            ['CMCD content', s.cmcd.contentId],
            ['Requests with CMCD', String(s.cmcdSent.count)],
            [
                'Last CMCD sent',
                last ? `${clock(new Date(last.t))} · ${describeCmcd(last.keys)}` : '--',
            ],
        ];
    }

    private renderNetwork(): void {
        const n = this.session.segments;
        kv(this.el('netKv'), [
            ['Segments loaded', String(n.count)],
            ['Avg segment load', n.count ? `${Math.round(n.ms / n.count)} ms` : '--'],
            ['Downloaded', `${(n.bytes / 1e6).toFixed(1)} MB`],
            ['HTTP errors', String(this.session.errorsHttp)],
            ...this.cmcdRows(),
        ]);
        const dot = this.el('count-network');
        dot.textContent = '';
        dot.className = this.session.errors ? 'pl-tab__dot' : 'pl-tab__count';
        dot.title = this.session.errors ? `${this.session.errors} errors` : '';
        this.renderWaterfall();
    }

    private renderWaterfall(): void {
        const box = this.el('waterfall');
        // Hold still while the pointer or keyboard is in it, so rows can be clicked.
        const paused = box.matches(':hover') || !!box.querySelector(':focus-visible');
        this.el('wfHint').textContent = paused
            ? ' · paused while you\u2019re here'
            : ' · click one for detail';
        if (paused) return;
        const now = performance.now();
        const from = now - WATERFALL_MS;
        const target = (this.session.playlist?.targetDuration ?? 6) * 1000;
        const rows = this.session.requests.filter((r) => r.end >= from).slice(-40);
        const pct = (t: number) => Math.max(0, ((t - from) / WATERFALL_MS) * 100);
        const selected = this.wfSelected?.key;
        box.replaceChildren(
            ...(rows.length
                ? rows.map((r) => {
                      const ms = Math.round(r.end - r.start);
                      const key = requestKey(r);
                      const left = pct(r.start);
                      const width = Math.max(0.4, pct(r.end) - left);
                      const wait =
                          r.ttfb != null && r.end > r.start
                              ? ((r.ttfb - r.start) / (r.end - r.start)) * 100
                              : null;
                      return h(
                          'button',
                          {
                              type: 'button',
                              role: 'listitem',
                              class: `pl-wf${key === selected ? ' is-selected' : ''}`,
                              title: `${r.name} · ${r.status ?? ''} · ${ms} ms${r.ttfb != null ? ` (first byte ${Math.round(r.ttfb - r.start)} ms)` : ''} · ${(r.bytes / 1024).toFixed(0)} KB`,
                              onclick: () => this.selectRequest(r),
                          },
                          h('span', {class: 'pl-wf__name'}, r.name),
                          h(
                              'span',
                              {class: 'pl-wf__track'},
                              h(
                                  'span',
                                  {
                                      class: `pl-wf__bar pl-wf--${requestState(r, target)}`,
                                      style: `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`,
                                  },
                                  // Waiting for the first byte, drawn lighter.
                                  ...(wait !== null
                                      ? [
                                            h('span', {
                                                class: 'pl-wf__wait',
                                                style: `width:${wait.toFixed(1)}%`,
                                            }),
                                        ]
                                      : []),
                              ),
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
                              ? (this.engine.limits ?? 'Waiting for requests…')
                              : 'Load a stream to see its requests.',
                      ),
                  ]),
        );
    }

    private selectRequest(r: RequestTiming | null): void {
        const panel = this.el('wfDetail');
        const key = r ? requestKey(r) : null;
        if (!r || key === this.wfSelected?.key) {
            this.wfSelected = null;
            panel.hidden = true;
        } else {
            this.wfSelected = {key: key as string, req: r};
            const d = requestDetail(r, this.engine?.name ?? 'the engine');
            panel.hidden = false;
            panel.replaceChildren(
                h(
                    'div',
                    {class: 'pl-wf-detail__head'},
                    h('b', {}, d.title),
                    h(
                        'span',
                        {class: 'pl-muted'},
                        clock(new Date(performance.timeOrigin + r.start)),
                    ),
                    h(
                        'button',
                        {
                            type: 'button',
                            class: 'link-button',
                            'aria-label': 'Close request detail',
                            onclick: () => this.selectRequest(null),
                        },
                        '×',
                    ),
                ),
                ...(d.waitShare !== null
                    ? [
                          h(
                              'div',
                              {
                                  class: 'pl-wf-detail__bar',
                                  title: 'Waiting for the first byte (light), then downloading',
                              },
                              h('span', {
                                  class: 'pl-wf-detail__wait',
                                  style: `width:${(d.waitShare * 100).toFixed(1)}%`,
                              }),
                              h('span', {class: 'pl-wf-detail__dl'}),
                          ),
                      ]
                    : []),
                h(
                    'dl',
                    {class: 'pl-wf-detail__list'},
                    ...d.rows.flatMap(([k, v]) => [
                        h('dt', {}, k),
                        h('dd', {class: k === 'URL' ? 'mono pl-wf-detail__url' : ''}, v),
                    ]),
                ),
                ...d.notes.map((n) => h('p', {class: 'pl-muted pl-wf-detail__note'}, n)),
            );
        }
        if (this.wfSelected) panel.scrollIntoView({block: 'nearest', behavior: 'smooth'});
        for (const row of this.el('waterfall').querySelectorAll<HTMLElement>('.pl-wf'))
            row.classList.toggle('is-selected', false);
        if (this.wfSelected) {
            const i = this.session.requests
                .filter((x) => x.end >= performance.now() - WATERFALL_MS)
                .slice(-40)
                .findIndex((x) => requestKey(x) === this.wfSelected?.key);
            this.el('waterfall')
                .querySelectorAll<HTMLElement>('.pl-wf')
                [i]?.classList.add('is-selected');
        }
    }

    /** Link to the channel's slicer in csl-slicer-console, when CSL_BASE_URL is set. */
    private renderSlicerLink(channel: ChannelOption | null): void {
        const link = this.el<HTMLAnchorElement>('slicerLink');
        const base = this.config.cslBase;
        const slicer = channel?.slicerId;
        link.hidden = !base || !slicer;
        if (!base || !slicer) return;
        link.href = `${base}/slicers/by-id/${encodeURIComponent(slicer)}`;
        link.textContent = `${slicer} ↗`;
        link.title = `Open ${slicer} in the slicer console`;
    }

    private renderStatus(): void {
        const s = this.session;
        const chips: HTMLElement[] = [];
        if (this.engine) {
            chips.push(
                h('span', {class: `chip${s.live ? ' chip--live' : ''}`}, s.live ? 'LIVE' : 'VOD'),
            );
            chips.push(h('span', {class: 'chip'}, `${this.engine.name} ${this.engine.version}`));
            if (this.source?.drm) {
                const ok = Object.values(s.keyStatuses);
                const state = ok.length
                    ? ok.every((x) => x === 'usable')
                        ? 'keys usable'
                        : 'key problem'
                    : 'waiting for license';
                chips.push(
                    h(
                        'span',
                        {class: `chip${state === 'key problem' ? ' chip--warn' : ''}`},
                        `${KEY_SYSTEM_NAMES[this.source.drm.keySystem]} · ${state}`,
                    ),
                );
            }
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
            if (s.cmcd) chips.push(h('span', {class: 'chip', title: s.cmcd.sessionId}, 'CMCD'));
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
        if (kind !== 'id3') capPush(s.history.log, entry, LIMITS.log);
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
        capPush(this.session.history.events, {t: now, kind, label}, LIMITS.events);
        while (tl.length && (tl[0] as TimelineEvent).t < now - WINDOW_MS) tl.shift();
    }

    private notice(
        kind: 'error' | 'info',
        message: string,
        ...actions: (HTMLElement | undefined)[]
    ): void {
        this.el('notices').append(
            h(
                'div',
                {class: `flash flash--${kind} pl-notice`},
                h('span', {}, message),
                h('span', {class: 'pl-notice__actions'}, ...actions),
            ),
        );
    }

    /** Open the compatibility panel and bring it into view. */
    private showCompat(): void {
        const panel = this.el<HTMLDetailsElement>('compat');
        if (!panel) return; // not shown in compare panes
        panel.open = true;
        panel.scrollIntoView({behavior: 'smooth', block: 'start'});
    }

    private clearNotices(): void {
        this.el('notices').replaceChildren();
    }
}

// ------------------------------------------------------------------ helpers

/** Green near the engine's target (or within 15 s), amber, then red past 45 s. */
export function driftState(drift: number | null, target: number | null): string | null {
    if (drift === null) return null;
    const ok = target ? target * 1.5 : 15;
    const bad = target ? Math.max(target * 3, 45) : 45;
    return drift <= ok ? 'state-good' : drift <= bad ? 'state-warn' : 'state-bad';
}

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

const KEY_STATUS_HINTS: Record<string, string> = {
    'output-restricted':
        'HDCP / output protection blocked this key (external display, screen capture or VM?)',
    'output-downscaled': 'Output protection forced a lower resolution',
    expired: 'License expired',
    'internal-error': 'The CDM failed on this key',
    released: 'Key released',
};

const shortKey = (id: string): string =>
    id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;

function pastedHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return 'unknown host';
    }
}

/** The newest Resource Timing entry for a URL, allowing for a CMCD= param added after it. */
function findResourceEntry(url: string): PerformanceResourceTiming | undefined {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= Math.max(0, entries.length - 200); i--) {
        const entry = entries[i] as PerformanceResourceTiming;
        const name = entry.name;
        if (name === url || name.startsWith(`${url}&CMCD=`) || name.startsWith(`${url}?CMCD=`))
            return entry;
    }
    return undefined;
}

function shortUrlFull(url: string): string {
    if (!url) return '--';
    try {
        const u = new URL(url);
        return `${u.host}${u.pathname}`;
    } catch {
        return url.slice(0, 60);
    }
}

/** Picker text: 🔒 for Studio DRM, ★ for pinned. */
export function channelLabel(c: ChannelOption): string {
    return `${c.encryption === 'drm' ? '🔒 ' : ''}${c.favorite ? '★ ' : ''}${c.name}`;
}

function isSafari(): boolean {
    const ua = navigator.userAgent;
    return /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/** FairPlay needs Safari's own HLS player and EME. */
function fairplaySupported(): boolean {
    return isSafari() && nativeHlsSupported() && 'requestMediaKeySystemAccess' in navigator;
}

/** The license URL a source was given (FairPlay's comes from each key URI). */
function sourceLicenseUrl(drm: DrmConfig | null | undefined): string | null {
    return drm && 'licenseUrl' in drm ? drm.licenseUrl : null;
}

/** Uplynk license endpoint for a pasted URL: same content zone, /wv or /pr. */
export function defaultLicenseUrl(url: string, drm: 'wv' | 'pr'): string {
    try {
        const u = new URL(url);
        const origin = /(^|\.)uplynk\.com$/.test(u.hostname)
            ? u.origin
            : 'https://content.uplynk.com';
        return `${origin}/${drm}`;
    } catch {
        return `https://content.uplynk.com/${drm}`;
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
    return text.replace(/([?&](?:amp;)?(?:sig|pbs)=)[^&\s"<]+/g, '$1…');
}
