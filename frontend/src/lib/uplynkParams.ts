// Uplynk customization params a load may sign in (docs "Customize Playback
// via Parameters"): the load bar's Params box and its + param menu. Keys the
// player sets itself (ad, rays, delay, pdts, the token) are refused here and
// pointed at their control. app/uplynk/params.py keeps the same rules for
// presets; tests/test_uplynk_params.py checks the two match.

export interface ParamInfo {
    key: string;
    /** What + param puts after `=`; '' leaves the cursor there. */
    value: string;
    help: string;
}

export interface ParamGroup {
    label: string;
    params: ParamInfo[];
}

const p = (key: string, value: string, help: string): ParamInfo => ({key, value, help});

/** The + param menu. Live-channel params only: VOD clipping and playlist ones are left out. */
export const PARAM_GROUPS: ParamGroup[] = [
    {
        label: 'General',
        params: [
            p(
                'expand',
                '',
                'Expansion sets from the CMS Parameter Expansion page, comma-separated',
            ),
            p('ddp', '1', 'Include Dolby Digital Plus audio (AAC only without it)'),
            p('ifo', '1', 'Add the I-frame playlist (trick play)'),
            p('hlsver', '', 'Minimum HLS version the player needs (max 9)'),
            p('maxfps', '', 'Leave out rays at or above this frame rate (maxfps=59 drops 60 fps)'),
            p('rates', '', 'Only rays in a bitrate range: low-high, either end optional'),
            p('resolutions', '', 'Only rays in a resolution range, e.g. 480-1080'),
            p('show_vtt', '1', 'WebVTT subtitles on HLS live (0 turns subtitles off)'),
            p('show_dash_subtitles', 'imsc', 'DASH: fragmented TTML (IMSC1) subtitles'),
            p('dash_subtitles_merge', '0', 'DASH: only the language tracks in the asset itself'),
            p('subtitle_placeholders_off', '1', 'Only language tracks that exist'),
            p('thumbsray', '1', 'Trick-play thumbnails in the manifest'),
            p('srs', 'templatetimeline', 'DASH segment timing: template or templatetimeline'),
            p('forcecic', '1', 'DASH live: always prepend a codec initialization clip'),
            p('smartcic', '1', 'DASH live: init clip only when the content has WebVTT'),
            p('nielsen', '1', 'DASH: the manifest may carry Nielsen emsg data'),
            p('needscors', '', 'CORS on the manifest: 0 any site, 1 specific headers'),
            p('euid', '', 'External user id, passed to ad servers and logs'),
            p('ptid', '', 'Tag playback with a group (32 characters at most)'),
            p('opaqueid', '', 'Viewer id, for up.max_concurrent_sessions'),
            p('up.max_concurrent_sessions', '', 'Concurrent sessions allowed (per opaqueid)'),
            p('geo.country.allow', '', 'Geoblocking: only these countries, comma-separated'),
            p('geo.country.deny', '', 'Geoblocking: not these countries, comma-separated'),
            p('repl', '', 'Replacement plugin to load (blackout)'),
            p('dmm.schemas.top', 'first_segment_url', 'Dynamic Manifest Marker at the top'),
            p('dmm.schemas.break', 'break_info', 'Ad break Dynamic Manifest Markers'),
            p('timedmeta.schemas.ads', 'omsdk', 'Ad viewability (OM SDK) data in the manifest'),
            p('timedmeta.events.ads', '', 'Ad tracking events in the manifest, comma-separated'),
            p('timedmeta.extensions.ads', '', 'VAST extensions in the manifest, comma-separated'),
            p('staticomsdk', '1', 'Static OM SDK JSON payload in the manifest'),
        ],
    },
    {
        label: 'Ads (with an ad server or an expand set)',
        params: [
            p('ad.breakend', 'chop', 'Keep ads inside the break: chop or drop'),
            p('ad.flex', '', 'Seconds an ad may run past the break'),
            p('ad.kv', '', 'Key-values for the ad server: key1,value1,key2,value2'),
            p('ad.timedmeta', '1', 'Dynamic Manifest Markers for ad breaks (+ dmm.schemas.break)'),
            p('ad.sssb', '1', 'Turn off server-side beacons'),
            p('ad.cping', '1', 'Enable the Ping API'),
            p('ad.prbd', '', 'Prebid configuration name'),
            p('ad._debug', '', 'Tag the session for ad debug data'),
            p('ad.preroll', '1', 'Pre-roll (undocumented); Preplay answers 500, so not with DRM'),
        ],
    },
    {
        label: 'Studio DRM',
        params: [
            p(
                'drm_policy_name',
                '',
                'Studio DRM policy configuration (an unknown name stops playback)',
            ),
            p('drm_optional', '1', 'Turn Studio DRM off (DASH needs ck=1 too)'),
            p('ck', '1', 'Cleartext content key: decrypt outside the CDM'),
            p('fpuseki', '1', 'FairPlay: fewer content key requests'),
            p('fp.hdcp', '', 'FairPlay HDCP: -1 off, 0 type 0, 1 type 1 (fp.hd.hdcp per track)'),
            p('fp.airplay', '0', 'FairPlay: 0 blocks AirPlay'),
            p('fp.lease_duration', '', 'FairPlay: seconds playback may run'),
            p(
                'rmp.policy_overrides.license_duration_seconds',
                '',
                'Widevine: license lifetime in seconds',
            ),
            p('rmp.policy_overrides.can_play', 'False', 'Widevine: False refuses playback'),
            p(
                'rmp.content_key_specs.ALL.security_level',
                '',
                'Widevine: minimum security level 1-5 (track: SD, HD, AUDIO, ALL_VIDEO…)',
            ),
            p(
                'rmp.content_key_specs.HD.required_output_protection.hdcp',
                'HDCP_V2',
                'Widevine: HDCP required for HD tracks',
            ),
            p('pr.version', '', 'PlayReady license version: 2 or 3'),
            p('pr.realtime_expiration', 'True', 'PlayReady: stop when the license expires'),
            p('pr.license_begin_seconds', '', 'PlayReady: seconds before now the license is valid'),
        ],
    },
];

/** Keys under these prefixes are families (ad.<anything>, fp.hd.hdcp, rmp.…, pr.hd.…). */
export const PARAM_PREFIXES = ['ad.', 'fp.', 'rmp.', 'pr.'];

/** Exact keys allowed: the menu's, less the prefixed families. */
export const PARAM_KEYS: ReadonlySet<string> = new Set(
    PARAM_GROUPS.flatMap((g) => g.params.map((q) => q.key)).filter(
        (k) => !PARAM_PREFIXES.some((pre) => k.startsWith(pre)),
    ),
);

/** Keys a load mustn't type, and where they're set instead. */
const RESERVED: Record<string, string> = {
    ad: 'choose the ad server in the Ads menu, not as ad=',
    rays: 'pick rays in the ABR tab, not as rays=',
    delay: 'use the Delay menu, not delay=',
    pdts: 'the player signs pdts=latency itself',
    cmcd: 'use the CMCD checkbox',
    CMCD: 'use the CMCD checkbox',
    ak: "ak= changes the signing key; the account's API key signs here",
    manifest: 'the player sets manifest= for Preplay',
    rmt: 'the player sets rmt= for Preplay (DRM menu)',
};
for (const key of ['tc', 'exp', 'rn', 'ct', 'cid', 'eid', 'oid', 'sig', 'pbs', 'jsonp']) {
    RESERVED[key] = `${key}= is part of the token`;
}

const KEY_RE = /^[A-Za-z0-9_.]{1,60}$/;
/** Values stay URL-plain on purpose. */
const VALUE_RE = /^[A-Za-z0-9_.,:/|\- ]{0,200}$/;
const EXPAND_RE = /^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64}){0,9}$/;
export const MAX_PARAMS = 20;

export function isParamKey(key: string): boolean {
    if (!KEY_RE.test(key) || key.endsWith('.')) return false;
    return PARAM_KEYS.has(key) || PARAM_PREFIXES.some((pre) => key.startsWith(pre));
}

export function paramInfo(key: string): ParamInfo | undefined {
    for (const group of PARAM_GROUPS) {
        const found = group.params.find((q) => q.key === key);
        if (found) return found;
    }
    return undefined;
}

export type ParsedParams = {query: string; pairs: [string, string][]} | {error: string};

/**
 * Params typed in the load bar (`expand=ad_kor&ad.lib=KOR`), or read from a
 * link or preset. `hasAd`: an ad server is chosen. ad.* params need one, or
 * an expand set (which may carry ad=). Returns the normalized query, or what's wrong.
 */
export function parseParams(text: string, hasAd: boolean): ParsedParams {
    const trimmed = text.trim().replace(/^[?&]+/, '');
    if (!trimmed) return {query: '', pairs: []};
    const pairs: [string, string][] = [];
    for (const part of trimmed.split('&')) {
        if (!part.trim()) continue;
        const at = part.indexOf('=');
        if (at < 0) return {error: `${part.trim()} needs a value (ifo=1)`};
        const key = part.slice(0, at).trim();
        let value: string;
        try {
            value = decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' ')).trim();
        } catch {
            return {error: `${part} isn't valid`};
        }
        const reserved = RESERVED[key];
        if (reserved) return {error: reserved};
        if (!isParamKey(key))
            return {error: `${key} isn't a param this player signs (see + param)`};
        if (!VALUE_RE.test(value)) return {error: `${key} has characters that aren't allowed`};
        if (key === 'expand' && !EXPAND_RE.test(value))
            return {error: 'expand= takes set names, comma-separated (expand=ad_01,playback_01)'};
        pairs.push([key, value]);
    }
    if (pairs.length > MAX_PARAMS) return {error: `at most ${MAX_PARAMS} params`};
    if (!hasAd && !pairs.some(([k]) => k === 'expand')) {
        const ad = pairs.find(([k]) => k.startsWith('ad.'));
        if (ad)
            return {error: `${ad[0]} needs an ad server (Ads) or an expand= set that names one`};
    }
    return {query: new URLSearchParams(pairs).toString(), pairs};
}
