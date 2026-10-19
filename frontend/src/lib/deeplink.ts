// The player's address bar is a shareable view: what to play and how.
//   ?channel=12&format=dash&engine=shaka@5.3.0&drm=wv&rays=fed&delay=20&cmcd=1#latency
// `src=` replaces `channel=` for a pasted URL; the tab stays in the hash.
// Links come from other people, so every value is checked before use:
// the engine version ends up in a jsDelivr URL.

import {parseDelay} from './clock';

export type LinkEngine = 'hls.js' | 'shaka-player' | 'dashjs' | 'native';

export interface View {
    channel?: number;
    src?: string;
    format?: 'm3u8' | 'mpd';
    engine?: LinkEngine;
    /** Exact npm version; absent = the default for the engine. */
    version?: string;
    drm?: 'wv' | 'pr' | 'fps';
    /** Ray letters to sign into `rays=`, highest first (synced channels only). */
    rays?: string;
    /** Uplynk `delay=` seconds to sign in (synced channels only). */
    delay?: number;
    /** Send CMCD with every request. */
    cmcd?: boolean;
}

/** Short names in links; the long npm names are accepted too. */
const ENGINE_NAMES: Record<string, LinkEngine> = {
    hlsjs: 'hls.js',
    'hls.js': 'hls.js',
    shaka: 'shaka-player',
    'shaka-player': 'shaka-player',
    dashjs: 'dashjs',
    'dash.js': 'dashjs',
    native: 'native',
};
const SHORT: Record<LinkEngine, string> = {
    'hls.js': 'hlsjs',
    'shaka-player': 'shaka',
    dashjs: 'dashjs',
    native: 'native',
};

/** An exact semver release, e.g. 1.6.15 or 5.0.0-beta.2; nothing that could be a path. */
export const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function isVersion(value: string): boolean {
    return VERSION_RE.test(value);
}

export function parseView(search: string): View {
    const q = new URLSearchParams(search);
    const view: View = {};
    const channel = Number(q.get('channel'));
    if (Number.isInteger(channel) && channel > 0) view.channel = channel;
    const src = q.get('src');
    if (src && /^https?:\/\//i.test(src)) view.src = src;
    const format = q.get('format')?.toLowerCase();
    if (format === 'hls' || format === 'm3u8') view.format = 'm3u8';
    if (format === 'dash' || format === 'mpd') view.format = 'mpd';
    const [name = '', version = ''] = (q.get('engine') ?? '').split('@');
    const engine = ENGINE_NAMES[name.toLowerCase()];
    if (engine) {
        view.engine = engine;
        if (engine !== 'native' && isVersion(version)) view.version = version;
    }
    const drm = q.get('drm');
    if (drm === 'wv' || drm === 'pr' || drm === 'fps') view.drm = drm;
    const rays = q.get('rays')?.toLowerCase() ?? '';
    if (/^[a-z]{1,26}$/.test(rays)) view.rays = [...new Set(rays)].sort().reverse().join('');
    const delay = parseDelay(q.get('delay'));
    if (delay !== null) view.delay = delay;
    if (q.get('cmcd') === '1') view.cmcd = true;
    return view;
}

/** The query string for a view, in a stable order; `src` and `channel` are exclusive. */
export function viewQuery(view: View): string {
    const q = new URLSearchParams();
    if (view.src) q.set('src', view.src);
    else if (view.channel) q.set('channel', String(view.channel));
    if (view.format === 'mpd') q.set('format', 'dash');
    if (view.engine) {
        const name = SHORT[view.engine];
        q.set(
            'engine',
            view.version && view.engine !== 'native' ? `${name}@${view.version}` : name,
        );
    }
    if (view.drm) q.set('drm', view.drm);
    if (view.rays && !view.src) q.set('rays', view.rays);
    if (view.delay !== undefined && !view.src) q.set('delay', String(view.delay));
    if (view.cmcd) q.set('cmcd', '1');
    // Keep @ and : readable; URLSearchParams escapes them.
    return q.toString().replace(/%40/g, '@').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
}
