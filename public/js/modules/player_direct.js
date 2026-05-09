/**
 * player_direct.js
 * Manages the Direct Stream Player page for pasting stream URLs.
 * Delegates actual playback to player-core.js.
 */

import { UIElements, guideState, appState } from './state.js';
import { showNotification } from './ui.js';
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream } from './api.js';
import { createPlayer, setupKeyboardShortcuts, detectStreamType } from './player-core.js';

const MAX_RECENT_LINKS = 10;
let currentStreamUrl = null;
let statisticsInterval = null;
let currentRedirectHistoryId = null;
let removeKeyboardShortcuts = null;

function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function logToPlayerConsole(message, isError = false) {
  const el = UIElements.directPlayerConsole;
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  const entry = document.createElement('p');
  entry.innerHTML = `<span class="text-gray-500">${ts}:</span> <span class="${isError ? 'text-red-400' : 'text-gray-300'}">${message}</span>`;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

function getRecentLinks() { return guideState.settings.recentDirectLinks || []; }
function saveRecentLinks(links) { guideState.settings.recentDirectLinks = links; saveUserSetting('recentDirectLinks', links); }

function addRecentLink(url) {
  let links = getRecentLinks().filter(l => l !== url);
  links.unshift(url);
  saveRecentLinks(links.slice(0, MAX_RECENT_LINKS));
}

function renderRecentLinks() {
  const links = getRecentLinks();
  UIElements.noRecentLinksMessage.classList.toggle('hidden', links.length > 0);
  UIElements.recentLinksTableContainer.classList.toggle('hidden', links.length === 0);
  const tbody = UIElements.recentLinksTbody;
  if (!tbody) return;
  tbody.innerHTML = '';
  links.forEach(link => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="max-w-md truncate" title="${link}"><a href="#" class="replay-link text-blue-400 hover:underline" data-url="${link}">${link}</a></td><td class="text-right"><button class="action-btn delete-recent-link-btn p-1" data-url="${link}"><svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg></button></td>`;
    tbody.appendChild(tr);
  });
}

export function initDirectPlayer() {
  if (isDirectPlayerActive()) stopAndCleanupDirectPlayer();
  if (UIElements.directPlayerForm) UIElements.directPlayerForm.reset();
  UIElements.directPlayCheckbox.checked = guideState.settings.directPlayEnabled === true;
  renderRecentLinks();
}

async function stopAndCleanupDirectPlayer() {
  if (currentRedirectHistoryId) { stopRedirectStream(currentRedirectHistoryId); currentRedirectHistoryId = null; }
  if (statisticsInterval) { clearInterval(statisticsInterval); statisticsInterval = null; }
  if (removeKeyboardShortcuts) { removeKeyboardShortcuts(); removeKeyboardShortcuts = null; }
  if (currentStreamUrl) { await stopStream(currentStreamUrl); }

  if (appState.player) {
    try { appState.player.stop(); } catch {}
    appState.player = null;
  }
  currentStreamUrl = null;

  if (UIElements.directVideoElement) {
    UIElements.directVideoElement.src = '';
    UIElements.directVideoElement.removeAttribute('src');
    UIElements.directVideoElement.load();
  }
  UIElements.directPlayerContainer.classList.add('hidden');
  UIElements.directPlayerConsoleContainer.classList.add('hidden');
  UIElements.directStopBtn.classList.add('hidden');
  UIElements.directPlayBtn.classList.remove('hidden');
}

export function cleanupDirectPlayer() { stopAndCleanupDirectPlayer(); }

export function isDirectPlayerActive() {
  return !!appState.player && !!currentStreamUrl;
}

function playDirectStream(url) {
  if (currentStreamUrl && currentStreamUrl !== url) stopAndCleanupDirectPlayer();
  else if (!currentStreamUrl) stopAndCleanupDirectPlayer();

  const consoleEl = UIElements.directPlayerConsole;
  if (consoleEl) consoleEl.innerHTML = '';
  UIElements.directPlayerConsoleContainer.classList.remove('hidden');
  logToPlayerConsole(`Attempting to play: ${url}`);

  const streamType = detectStreamType(url);
  logToPlayerConsole(`Detected: ${streamType.extension} (${streamType.type})`);
  currentStreamUrl = url;
  addRecentLink(url);
  renderRecentLinks();

  if (streamType.type === 'vod') playVODStream(url, streamType);
  else playLiveStream(url, streamType);
}

function playVODStream(url, streamType) {
  if (UIElements.directPlayCheckbox.checked) {
    logToPlayerConsole('Direct Play ON — using native video.');
    if (currentRedirectHistoryId) { stopRedirectStream(currentRedirectHistoryId); currentRedirectHistoryId = null; }
    startRedirectStream(url, null, 'Direct Player Video', null).then(id => { if (id) currentRedirectHistoryId = id; });
    UIElements.directPlayerContainer.classList.remove('hidden');
    UIElements.directStopBtn.classList.remove('hidden');
    UIElements.directPlayBtn.classList.add('hidden');
    const video = UIElements.directVideoElement;
    video.src = url;
    video.load();
    video.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);
    video.play().then(() => {
      logToPlayerConsole('Playback started.');
      removeKeyboardShortcuts = setupKeyboardShortcuts(video, () => stopAndCleanupDirectPlayer());
    }).catch(() => {
      logToPlayerConsole(`Cannot play ${streamType.extension} natively. Try unchecking Direct Play.`, true);
      stopAndCleanupDirectPlayer();
    });
    return;
  }

  logToPlayerConsole('Direct Play OFF — using server transcoding.');
  const settings = guideState.settings;
  const userAgentId = settings.activeUserAgentId;
  const profileId = guideState.hardware?.nvidia ? 'ffmpeg-fmp4-nvidia' : 'ffmpeg-fmp4';
  const profile = (settings.streamProfiles || []).find(p => p.id === profileId);
  if (!profileId || !userAgentId || !profile) {
    logToPlayerConsole('Profile or user agent not set. Check settings.', true);
    return;
  }

  const strUrl = `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
  logToPlayerConsole(`Stream URL: ${strUrl}`);

  const video = UIElements.directVideoElement;
  UIElements.directPlayerContainer.classList.remove('hidden');
  UIElements.directStopBtn.classList.remove('hidden');
  UIElements.directPlayBtn.classList.add('hidden');
  video.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

  video.addEventListener('error', () => {
    const err = video.error;
    const msgs = ['Aborted', 'Network error', 'Decode failed', 'Format not supported'];
    logToPlayerConsole(err ? msgs[err.code - 1] || 'Unknown' : 'Unknown', true);
    stopAndCleanupDirectPlayer();
  }, { once: true });

  video.addEventListener('loadedmetadata', () => {
    video.play().then(() => {
      logToPlayerConsole('Playback started.');
      removeKeyboardShortcuts = setupKeyboardShortcuts(video, () => stopAndCleanupDirectPlayer());
      if (statisticsInterval) clearInterval(statisticsInterval);
      statisticsInterval = setInterval(() => {
        if (video.buffered.length > 0 && !video.paused) {
          const buf = video.buffered.end(0) - video.currentTime;
          logToPlayerConsole(`Time: ${formatTime(video.currentTime)}/${formatTime(video.duration)} — Buffer: ${buf.toFixed(2)}s — ${video.videoWidth}x${video.videoHeight}`);
        }
      }, 2000);
    }).catch(err => {
      if (err.name !== 'AbortError') { logToPlayerConsole(`Play error: ${err.message}`, true); stopAndCleanupDirectPlayer(); }
    });
  }, { once: true });

  video.src = strUrl;
}

function playLiveStream(url, streamType) {
  let streamUrl = url;

  if (!UIElements.directPlayCheckbox.checked) {
    const st = guideState.settings;
    const profileId = st.activeStreamProfileId;
    const userAgentId = st.activeUserAgentId;
    if (!profileId || !userAgentId) { logToPlayerConsole('Profile or user agent not set. Check settings.', true); return; }
    streamUrl = `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
    logToPlayerConsole(`Using server proxy: ${streamUrl}`);
  } else {
    logToPlayerConsole('Direct Play ON — connecting directly.');
    if (currentRedirectHistoryId) { stopRedirectStream(currentRedirectHistoryId); currentRedirectHistoryId = null; }
    const channel = (guideState.channels || []).find(c => c.url === url);
    startRedirectStream(url, channel?.id || null, channel?.displayName || channel?.name || 'Direct Stream', channel?.logo || null)
      .then(id => { if (id) currentRedirectHistoryId = id; });
  }

  const video = UIElements.directVideoElement;

  appState.player = createPlayer({
    url: streamUrl,
    video,
    isLive: true,
    onError: (type, detail) => {
      logToPlayerConsole(`${type}: ${detail}`, true);
      stopAndCleanupDirectPlayer();
    },
  });

  if (!appState.player) { logToPlayerConsole('Browser does not support MSE.', true); return; }

  UIElements.directPlayerContainer.classList.remove('hidden');
  UIElements.directStopBtn.classList.remove('hidden');
  UIElements.directPlayBtn.classList.add('hidden');
  video.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);
  logToPlayerConsole('Player created, loading stream...');
  removeKeyboardShortcuts = setupKeyboardShortcuts(video, () => stopAndCleanupDirectPlayer());

  if (statisticsInterval) clearInterval(statisticsInterval);
  statisticsInterval = setInterval(() => {
    if (video.buffered.length > 0 && !video.paused) {
      logToPlayerConsole(`Buffer: ${(video.buffered.end(0) - video.currentTime).toFixed(2)}s — ${video.videoWidth}x${video.videoHeight}`);
    }
  }, 2000);
}

// --- Event listeners ---

export function setupDirectPlayerEventListeners() {
  UIElements.directPlayerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = UIElements.directStreamUrl.value.trim();
    if (url) playDirectStream(url);
    else showNotification('Please enter a stream URL.', true);
  });

  UIElements.directStopBtn.addEventListener('click', stopAndCleanupDirectPlayer);

  UIElements.directPlayCheckbox.addEventListener('change', () => {
    guideState.settings.directPlayEnabled = UIElements.directPlayCheckbox.checked;
    saveUserSetting('directPlayEnabled', UIElements.directPlayCheckbox.checked);
  });

  UIElements.recentLinksTbody.addEventListener('click', (e) => {
    const replay = e.target.closest('.replay-link');
    const del = e.target.closest('.delete-recent-link-btn');
    if (replay) { e.preventDefault(); UIElements.directStreamUrl.value = replay.dataset.url; playDirectStream(replay.dataset.url); }
    else if (del) { saveRecentLinks(getRecentLinks().filter(l => l !== del.dataset.url)); renderRecentLinks(); }
  });
}
