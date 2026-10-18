// Page config rendered by Flask into <script id="player-config">.

export interface ChannelOption {
    id: number;
    name: string;
    account: string;
    channelId: string;
    favorite: boolean;
}

export interface PlayerConfig {
    channels: ChannelOption[];
    initialChannel: number | null;
    initialSrc: string | null;
    endpoints: {playback: string; versions: string};
}

export function readConfig(): PlayerConfig {
    const el = document.getElementById('player-config');
    if (!el?.textContent) throw new Error('player-config missing');
    return JSON.parse(el.textContent) as PlayerConfig;
}
