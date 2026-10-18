// "What plays where": a live capability check for this browser plus the
// browser × format × DRM matrix and how Uplynk maps onto it.

import {h} from './dom';

type Cell = 'yes' | 'no' | 'partial';

interface Row {
    id: BrowserId;
    browser: string;
    cells: [Cell, string][]; // matches COLUMNS
}

type BrowserId = 'chrome' | 'edge' | 'firefox' | 'safari-mac' | 'safari-ios' | 'chrome-android';

const COLUMNS = [
    'HLS clear / AES-128',
    'DASH clear',
    'Widevine (DASH)',
    'PlayReady (DASH)',
    'FairPlay (HLS)',
];

const ROWS: Row[] = [
    {
        id: 'chrome',
        browser: 'Chrome (Mac, Windows, Linux)',
        cells: [
            ['yes', 'hls.js'],
            ['yes', 'Shaka, dash.js'],
            ['yes', 'L3, software'],
            ['no', ''],
            ['no', ''],
        ],
    },
    {
        id: 'edge',
        browser: 'Edge (Windows)',
        cells: [
            ['yes', 'hls.js'],
            ['yes', 'Shaka, dash.js'],
            ['yes', 'L3, software'],
            ['yes', 'SL2000/3000'],
            ['no', ''],
        ],
    },
    {
        id: 'firefox',
        browser: 'Firefox',
        cells: [
            ['yes', 'hls.js'],
            ['yes', 'Shaka, dash.js'],
            ['yes', 'L3, software'],
            ['partial', 'varies; see live check'],
            ['no', ''],
        ],
    },
    {
        id: 'safari-mac',
        browser: 'Safari (macOS)',
        cells: [
            ['yes', 'native or hls.js'],
            ['yes', 'Shaka, dash.js (MSE)'],
            ['no', ''],
            ['no', ''],
            ['yes', 'native'],
        ],
    },
    {
        id: 'safari-ios',
        browser: 'Safari (iPhone, iPad)',
        cells: [
            ['yes', 'native'],
            ['partial', 'Managed MSE only'],
            ['no', ''],
            ['no', ''],
            ['yes', 'native'],
        ],
    },
    {
        id: 'chrome-android',
        browser: 'Chrome (Android)',
        cells: [
            ['yes', 'hls.js'],
            ['yes', 'Shaka, dash.js'],
            ['yes', 'L1 or L3'],
            ['no', ''],
            ['no', ''],
        ],
    },
];

export function detectBrowser(ua: string = navigator.userAgent): BrowserId | null {
    if (/Edg\//.test(ua)) return 'edge';
    if (/Android/.test(ua) && /Chrome\//.test(ua)) return 'chrome-android';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/(iPhone|iPad|iPod)/.test(ua)) return 'safari-ios';
    if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'safari-mac';
    return null;
}

const MARK: Record<Cell, string> = {yes: '✓', no: '✗', partial: '~'};

function matrix(current: BrowserId | null): HTMLElement {
    return h(
        'div',
        {class: 'pl-table-wrap'},
        h(
            'table',
            {class: 'pl-compat'},
            h(
                'thead',
                {},
                h('tr', {}, h('th', {}, 'Browser'), ...COLUMNS.map((c) => h('th', {}, c))),
            ),
            h(
                'tbody',
                {},
                ...ROWS.map((row) =>
                    h(
                        'tr',
                        {class: row.id === current ? 'is-current' : ''},
                        h(
                            'td',
                            {},
                            row.browser,
                            row.id === current
                                ? h('span', {class: 'pl-compat__you'}, 'this browser')
                                : null,
                        ),
                        ...row.cells.map(([cell, note]) =>
                            h(
                                'td',
                                {class: `pl-compat__${cell}`},
                                h('b', {}, MARK[cell]),
                                note ? h('small', {}, note) : null,
                            ),
                        ),
                    ),
                ),
            ),
        ),
    );
}

interface Check {
    label: string;
    run: () => Promise<[Cell, string]>;
}

const withTimeout = <T>(p: Promise<T>, ms = 3000): Promise<T | 'timeout'> =>
    Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);

async function keySystem(
    system: string,
    config: MediaKeySystemConfiguration,
): Promise<[Cell, string]> {
    if (!navigator.requestMediaKeySystemAccess) return ['no', 'no EME'];
    try {
        const result = await withTimeout(navigator.requestMediaKeySystemAccess(system, [config]));
        return result === 'timeout' ? ['partial', 'no answer'] : ['yes', ''];
    } catch {
        return ['no', ''];
    }
}

const MP4 = 'video/mp4; codecs="avc1.42E01E"';

const CHECKS: Check[] = [
    {
        label: 'Secure context (HTTPS)',
        run: async () =>
            window.isSecureContext ? ['yes', ''] : ['no', 'DRM needs HTTPS or localhost'],
    },
    {
        label: 'Media Source Extensions',
        run: async () => {
            const w = window as unknown as {MediaSource?: unknown; ManagedMediaSource?: unknown};
            if (w.MediaSource) return ['yes', 'hls.js, Shaka and dash.js run'];
            if (w.ManagedMediaSource) return ['partial', 'ManagedMediaSource only'];
            return ['no', 'only native playback'];
        },
    },
    {
        label: 'Native HLS',
        run: async () => {
            const can = document
                .createElement('video')
                .canPlayType('application/vnd.apple.mpegurl');
            return can
                ? ['yes', `canPlayType says "${can}"; try the Native engine`]
                : ['no', 'HLS needs hls.js here'];
        },
    },
    {
        label: 'Widevine',
        run: async () => {
            const base = {initDataTypes: ['cenc'], videoCapabilities: [{contentType: MP4}]};
            const [any] = await keySystem('com.widevine.alpha', base);
            if (any !== 'yes') return [any, ''];
            const [hw] = await keySystem('com.widevine.alpha', {
                ...base,
                videoCapabilities: [{contentType: MP4, robustness: 'HW_SECURE_ALL'}],
            });
            return ['yes', hw === 'yes' ? 'hardware (L1)' : 'software (L3)'];
        },
    },
    {
        label: 'PlayReady',
        run: async () => {
            const cfg = {initDataTypes: ['cenc'], videoCapabilities: [{contentType: MP4}]};
            const [rec] = await keySystem('com.microsoft.playready.recommendation', cfg);
            if (rec === 'yes') return ['yes', 'recommendation'];
            return keySystem('com.microsoft.playready', cfg);
        },
    },
    {
        label: 'FairPlay',
        run: async () =>
            keySystem('com.apple.fps', {
                initDataTypes: ['sinf', 'skd'],
                videoCapabilities: [{contentType: 'video/mp4'}],
            }),
    },
    {
        label: 'ClearKey',
        run: async () =>
            keySystem('org.w3.clearkey', {
                initDataTypes: ['cenc', 'keyids'],
                videoCapabilities: [{contentType: MP4}],
            }),
    },
];

async function runChecks(list: HTMLElement): Promise<void> {
    const rows = CHECKS.map((check) => {
        const value = h('span', {class: 'pl-compat__pending'}, 'checking…');
        list.append(h('div', {class: 'pl-check'}, h('span', {}, check.label), value));
        return {check, value};
    });
    await Promise.all(
        rows.map(async ({check, value}) => {
            const [cell, note] = await check
                .run()
                .catch((): [Cell, string] => ['no', 'check failed']);
            value.className = `pl-compat__${cell}`;
            value.replaceChildren(h('b', {}, MARK[cell]), note ? ` ${note}` : '');
        }),
    );
}

const STORAGE_KEY = 'player-harness:compat-open';

export function buildCompatPanel(): HTMLDetailsElement {
    const current = detectBrowser();
    const checks = h('div', {class: 'pl-checks'});
    let ran = false;
    const details = h(
        'details',
        {class: 'pl-panel pl-compat-panel', id: 'pl-compat'},
        h(
            'summary',
            {class: 'pl-panel__title'},
            'Compatibility: which browser, format, DRM and player work together',
        ),
        h(
            'div',
            {class: 'pl-compat-body'},
            h('div', {}, h('p', {class: 'pl-subhead'}, 'This browser, checked live'), checks),
            h(
                'div',
                {},
                h('p', {class: 'pl-subhead'}, 'What plays where'),
                matrix(current),
                h(
                    'p',
                    {class: 'pl-muted'},
                    '✓ works · ✗ not available · ~ partly. Software Widevine (L3) is capped at lower resolutions by many services; hardware (L1) needs a supported device. PlayReady in the browser is Edge on Windows. DRM (EME) only runs on HTTPS or localhost.',
                ),
            ),
            h(
                'div',
                {class: 'pl-compat-notes'},
                h('p', {class: 'pl-subhead'}, 'How Uplynk fits'),
                h(
                    'ul',
                    {},
                    h(
                        'li',
                        {},
                        h('b', {}, 'Studio DRM over HLS is FairPlay'),
                        ' (SAMPLE-AES, skd:// keys). Only Safari can decrypt it; Chrome, Edge and Firefox fail at the key.',
                    ),
                    h(
                        'li',
                        {},
                        h('b', {}, 'Studio DRM over DASH is CENC'),
                        ': Preplay v2 with ',
                        h('code', {}, 'rmt=wv'),
                        ' or ',
                        h('code', {}, 'rmt=pr'),
                        ' returns the session MPD and its Widevine / PlayReady license URL (',
                        h('code', {}, '<prefix>/wv'),
                        ', ',
                        h('code', {}, '/pr'),
                        ').',
                    ),
                    h(
                        'li',
                        {},
                        h('b', {}, 'Without DRM'),
                        ', HLS is clear or AES-128 and plays everywhere. Uplynk DASH is still CENC: the MPD names a Widevine license URL (',
                        h('code', {}, 'ms:laurl'),
                        ') that the players use on their own. DASH needs the content packaged for it; otherwise Uplynk answers ',
                        h('code', {}, 'Non dash asset'),
                        '.',
                    ),
                    h(
                        'li',
                        {},
                        h('b', {}, 'Engines in this harness:'),
                        ' hls.js for HLS (clear, AES-128); Shaka Player or dash.js for DASH and Widevine / PlayReady; Native hands HLS to the browser itself (Safari), with fewer metrics. FairPlay playback in Safari is not built yet.',
                    ),
                ),
            ),
        ),
    );
    const open = () => {
        if (!ran) {
            ran = true;
            void runChecks(checks);
        }
    };
    details.addEventListener('toggle', () => {
        if (details.open) open();
        try {
            localStorage.setItem(STORAGE_KEY, details.open ? '1' : '0');
        } catch {
            /* storage unavailable: just don't remember */
        }
    });
    try {
        if (localStorage.getItem(STORAGE_KEY) === '1') details.open = true;
    } catch {
        /* ignore */
    }
    if (details.open) open();
    return details;
}
