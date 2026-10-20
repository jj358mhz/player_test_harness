// Page config rendered by Flask into <script id="player-config">.

export interface ChannelOption {
    id: number;
    name: string;
    account: string;
    channelId: string;
    favorite: boolean;
    /** Last HLS probe: 'drm' (Studio DRM), 'aes-128', 'sample-aes', 'none'; null = unchecked. */
    encryption?: string | null;
    /** Uplynk slicer feeding the channel (links to csl-slicer-console). */
    slicerId?: string | null;
    /** The channel's Uplynk account (keys `adServers`). */
    accountId?: number;
}

/** An SSAI ad configuration name entered on the account page (`ad=<name>`). */
export interface AdServerOption {
    name: string;
    description: string | null;
    /** Extra `ad.*` params signed with it, as a query string. */
    params: string;
}

/** A saved load-bar setup (deep-link query without a source). */
export interface Preset {
    id: number;
    name: string;
    query: string;
}

export interface PlayerConfig {
    channels: ChannelOption[];
    initialChannel: number | null;
    initialSrc: string | null;
    /** Saved engine presets, by name. */
    presets?: Preset[];
    /** Ad servers per account id. */
    adServers?: Record<string, AdServerOption[]>;
    endpoints: {
        playback: string;
        sessions: string;
        presets?: string;
        versions: Record<string, string>;
        /** Channel slicer settings from csl-slicer-console, "{id}" = channel; null = off. */
        slicer?: string | null;
    };
    /** A pane of the compare page: no compatibility panel or Copy link. */
    embed?: boolean;
    /** csl-slicer-console base URL (CSL_BASE_URL); null = no slicer links. */
    cslBase?: string | null;
}

export function readConfig(): PlayerConfig {
    const el = document.getElementById('player-config');
    if (!el?.textContent) throw new Error('player-config missing');
    return JSON.parse(el.textContent) as PlayerConfig;
}
