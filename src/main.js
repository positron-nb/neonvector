import './style.css';
import { Game } from './game/Game.js';

const canvas = document.getElementById('game-canvas');

try {
  window.__neonVectorGame = new Game(canvas);
} catch (err) {
  console.error('NEON VECTOR failed to start:', err);
  const msg = document.createElement('div');
  msg.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#03030a;color:#ff5566;font-family:monospace;padding:40px;text-align:center;z-index:9999;';
  msg.textContent = 'NEON VECTOR failed to initialize. Check the browser console for details: ' + (err && err.message ? err.message : err);
  document.body.appendChild(msg);
}
