import './styles/player.css';
import {PlayerApp} from './app';
import {readConfig} from './config';

declare global {
    interface Window {
        /** The page's player; the compare page reads panes through it. */
        playerApp?: PlayerApp;
    }
}

const root = document.getElementById('player-app');
if (root) window.playerApp = new PlayerApp(root, readConfig());
