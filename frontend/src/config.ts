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
}

export interface PlayerConfig {
    channels: ChannelOption[];
    initialChannel: number | null;
    initialSrc: string | null;
    endpoints: {
        playback: string;
        sessions: string;
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
