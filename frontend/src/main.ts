import './styles/player.css';
import {PlayerApp} from './app';
import {readConfig} from './config';

const root = document.getElementById('player-app');
if (root) new PlayerApp(root, readConfig());
