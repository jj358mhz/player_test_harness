// Page config rendered by Flask into <script id="player-config">.

export interface ChannelOption {
    id: number;
    name: string;
    account: string;
    channelId: string;
    favorite: boolean;
    /** Last HLS probe: 'drm' (Studio DRM), 'aes-128', 'sample-aes', 'none'; null = unchecked. */
    encryption?: string | null;
}

export interface PlayerConfig {
    channels: ChannelOption[];
    initialChannel: number | null;
    initialSrc: string | null;
    endpoints: {playback: string; sessions: string; versions: Record<string, string>};
    /** A pane of the compare page: no compatibility panel or Copy link. */
    embed?: boolean;
}

export function readConfig(): PlayerConfig {
    const el = document.getElementById('player-config');
    if (!el?.textContent) throw new Error('player-config missing');
    return JSON.parse(el.textContent) as PlayerConfig;
}
