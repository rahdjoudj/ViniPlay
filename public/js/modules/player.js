/**
 * player.js
 * Manages the video player modal, Google Cast, PiP, and aspect ratio.
 * Delegates actual stream playback to player-core.js.
 */

import { appState, guideState, UIElements } from './state.js';
import { saveUserSetting, stopStream, startRedirectStream, stopRedirectStream } from './api.js';
import { showNotification, openModal, closeModal } from './ui.js';
import { castState, loadMedia, setLocalPlayerState } from './cast.js';
import { ICONS } from './icons.js';
import { createPlayer, setupMediaSession, clearMediaSession, setupKeyboardShortcuts } from './player-core.js';

let streamInfoInterval = null;
let currentLocalStreamUrl = null;
let currentProfileId = null;
let currentRedirectHistoryId = null;
let currentChannelInfo = null;
let retryCount = 0;
let retryTimeout = null;
let removeKeyboardShortcuts = null;
const MAX_RETRIES = 3;

function handleStreamError() {
  if (retryCount >= MAX_RETRIES) {
    showNotification(`Stream failed after ${MAX_RETRIES} retries. Please try another channel.`, true, 5000);
    stopAndCleanupPlayer();
    return;
  }
  retryCount++;
  showNotification(`Stream interrupted. Retrying... (${retryCount}/${MAX_RETRIES})`, true, 2000);
  if (retryTimeout) clearTimeout(retryTimeout);
  retryTimeout = setTimeout(() => {
    if (currentChannelInfo) {
      playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
    } else {
      stopAndCleanupPlayer();
    }
  }, 2000);
}

export async function forceRefreshStream() {
  if (!currentChannelInfo) {
    showNotification('No active stream to refresh.', true);
    return;
  }
  showNotification('Refreshing stream...', false, 2000);
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
  retryCount = 0;
  if (appState.player) { appState.player.stop(); appState.player = null; }
  if (streamInfoInterval) { clearInterval(streamInfoInterval); streamInfoInterval = null; }
  playChannel(currentChannelInfo.url, currentChannelInfo.name, currentChannelInfo.channelId);
}

export const stopAndCleanupPlayer = async () => {
  if (currentRedirectHistoryId) {
    stopRedirectStream(currentRedirectHistoryId);
    currentRedirectHistoryId = null;
  }
  if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
  retryCount = 0;
  currentChannelInfo = null;

  if (currentLocalStreamUrl && !castState.isCasting) {
    await stopStream(currentLocalStreamUrl, currentProfileId);
    currentLocalStreamUrl = null;
    currentProfileId = null;
  }
  if (streamInfoInterval) { clearInterval(streamInfoInterval); streamInfoInterval = null; }
  if (UIElements.streamInfoOverlay) UIElements.streamInfoOverlay.classList.add('hidden');

  if (appState.player) { appState.player.stop(); appState.player = null; }
  UIElements.videoElement.src = '';
  UIElements.videoElement.removeAttribute('src');
  UIElements.videoElement.load();

  clearMediaSession();
  if (removeKeyboardShortcuts) { removeKeyboardShortcuts(); removeKeyboardShortcuts = null; }

  setLocalPlayerState(null, null, null);

  if (castState.isCasting) { closeModal(UIElements.videoModal); return; }
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); }
  closeModal(UIElements.videoModal);
};

function updateStreamInfo({ resolution, buffer, fps, dropped, bandwidth, videoCodec, audioCodec } = {}) {
  if (UIElements.streamInfoResolution) UIElements.streamInfoResolution.textContent = `Resolution: ${resolution || 'N/A'}`;
  if (UIElements.streamInfoBandwidth) UIElements.streamInfoBandwidth.textContent = `Bandwidth: ${bandwidth || 'N/A'}`;
  if (UIElements.streamInfoFps) UIElements.streamInfoFps.textContent = `FPS: ${fps || 'N/A'}`;
  if (UIElements.streamInfoDropped) UIElements.streamInfoDropped.textContent = `Dropped: ${dropped ?? 'N/A'}`;
  if (UIElements.streamInfoBuffer) UIElements.streamInfoBuffer.textContent = `Buffer: ${buffer || '0.00'}s`;
  if (UIElements.streamInfoVideo) UIElements.streamInfoVideo.textContent = `V Codec: ${videoCodec || 'N/A'}`;
  if (UIElements.streamInfoAudio) UIElements.streamInfoAudio.textContent = `A Codec: ${audioCodec || 'N/A'}`;
}

export const playChannel = async (url, name, channelId) => {
  if (!retryTimeout) retryCount = 0;
  currentChannelInfo = { url, name, channelId };

  if (channelId) {
    const recent = [channelId, ...(guideState.settings.recentChannels || []).filter(id => id !== channelId)].slice(0, 15);
    guideState.settings.recentChannels = recent;
    saveUserSetting('recentChannels', recent);
  }

  const profileId = guideState.settings.activeStreamProfileId;
  const userAgentId = guideState.settings.activeUserAgentId;
  if (!profileId || !userAgentId) {
    showNotification('Active stream profile or user agent not set. Please check settings.', true);
    return;
  }

  if (currentRedirectHistoryId) { stopRedirectStream(currentRedirectHistoryId); currentRedirectHistoryId = null; }

  const profile = (guideState.settings.streamProfiles || []).find(p => p.id === profileId);
  if (!profile) return showNotification('Stream profile not found.', true);

  if (profile.command === 'redirect') {
    const channel = guideState.channels.find(c => c.id === channelId);
    startRedirectStream(url, channelId, name, channel ? channel.logo : '')
      .then(id => { if (id) currentRedirectHistoryId = id; });
  }

  const streamUrl = profile.command === 'redirect' ? url
    : `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}`;
  const channel = guideState.channels.find(c => c.id === channelId);
  const logo = channel?.logo || '';

  if (castState.isCasting) {
    const absUrl = streamUrl.startsWith('http') ? streamUrl : `${window.location.origin}${streamUrl}`;
    loadMedia(absUrl, name, logo);
    openModal(UIElements.videoModal);
    return;
  }

  currentLocalStreamUrl = url;
  currentProfileId = profileId;
  setLocalPlayerState(streamUrl, name, logo, url, profileId);

  if (appState.player) { appState.player.stop(); appState.player = null; }
  if (streamInfoInterval) { clearInterval(streamInfoInterval); streamInfoInterval = null; }

  appState.player = await createPlayer({
    url: streamUrl,
    video: UIElements.videoElement,
    isLive: true,
    onError: (type, detail, fatal) => {
      if (fatal && (type === 'NetworkError' || type === 'MediaError')) {
        if (appState.player) handleStreamError();
      } else if (fatal) {
        showNotification(`Player Error: ${detail}`, true);
        stopAndCleanupPlayer();
      }
    },
    onRecovered: () => {
      retryCount = 0;
      if (retryTimeout) { clearTimeout(retryTimeout); retryTimeout = null; }
    },
    onStats: (stats) => updateStreamInfo(stats),
  });

  if (!appState.player) {
    showNotification('Your browser does not support the required playback technology.', true);
    return;
  }

  openModal(UIElements.videoModal);
  UIElements.videoTitle.textContent = name;
  UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);

  setupMediaSession({ title: name, artwork: logo });
  removeKeyboardShortcuts = setupKeyboardShortcuts(UIElements.videoElement, () => stopAndCleanupPlayer());

  streamInfoInterval = setInterval(() => {}, 2000);

  UIElements.videoElement.addEventListener('loadedmetadata', () => {
    if (isAspectRatioLocked && UIElements.videoElement.videoWidth) {
      const ratio = UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
      const width = UIElements.videoModalContainer.offsetWidth;
      const header = UIElements.videoModalContainer.querySelector('.flex.justify-between');
      UIElements.videoModalContainer.style.height = `${(width / ratio) + (header?.offsetHeight || 0)}px`;
    }
  }, { once: true });
};

export const playVOD = async (url, title, logo = '') => {
  const useDirectPlay = guideState.settings.vodDirectPlayEnabled === true;
  await stopAndCleanupPlayer();

  if (useDirectPlay) {
    UIElements.videoTitle.textContent = title;
    UIElements.videoElement.src = url;
    UIElements.videoElement.load();
    openModal(UIElements.videoModal);
    setLocalPlayerState(null, null, null);
    currentLocalStreamUrl = null;
    startRedirectStream(url, null, title, null).then(id => { if (id) currentRedirectHistoryId = id; });
    try {
      UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);
      await UIElements.videoElement.play();
      setupMediaSession({ title, artwork: logo });
      removeKeyboardShortcuts = setupKeyboardShortcuts(UIElements.videoElement, () => stopAndCleanupPlayer());
    } catch (err) {
      showNotification(`Could not play: ${err.message}`, true);
      UIElements.videoElement.src = '';
      UIElements.videoElement.removeAttribute('src');
      UIElements.videoElement.load();
      closeModal(UIElements.videoModal);
    }
    return;
  }

  const settings = guideState.settings;
  const profileId = settings.activeStreamProfileId;
  const userAgentId = settings.activeUserAgentId;
  const profile = (settings.streamProfiles || []).find(p => p.id === profileId);
  if (!profileId || !userAgentId || !profile) {
    showNotification('Active stream profile or user agent not set. Check settings.', true);
    return;
  }

  const streamUrl = profile.command === 'redirect' ? url
    : `/stream?url=${encodeURIComponent(url)}&profileId=${profileId}&userAgentId=${userAgentId}&vodName=${encodeURIComponent(title)}&vodLogo=${encodeURIComponent(logo)}`;

  if (profile.command !== 'redirect') { currentLocalStreamUrl = url; currentProfileId = profileId; }
  if (profile.command === 'redirect') {
    startRedirectStream(url, null, title, logo).then(id => { if (id) currentRedirectHistoryId = id; });
  }

  appState.player = await createPlayer({
    url: streamUrl,
    video: UIElements.videoElement,
    isLive: false,
    onError: (_type, detail) => {
      showNotification(`Playback error: ${detail}`, true);
      stopAndCleanupPlayer();
    },
    onStats: (stats) => updateStreamInfo(stats),
  });

  if (!appState.player) {
    showNotification('Your browser does not support the required playback technology.', true);
    return;
  }

  openModal(UIElements.videoModal);
  UIElements.videoTitle.textContent = title;
  UIElements.videoElement.volume = parseFloat(localStorage.getItem('iptvPlayerVolume') || 0.5);
  setupMediaSession({ title, artwork: logo });
  removeKeyboardShortcuts = setupKeyboardShortcuts(UIElements.videoElement, () => stopAndCleanupPlayer());
  setLocalPlayerState(streamUrl, title, logo);
  if (streamInfoInterval) clearInterval(streamInfoInterval);
  streamInfoInterval = setInterval(() => {}, 2000);
};

// --- Audio / Subtitle tracks ---

function updateAudioTrackList() {
  const video = UIElements.videoElement;
  const tracks = video.audioTracks;
  const listEl = document.getElementById('audio-track-list');
  const btnEl = document.getElementById('audio-track-btn');
  if (!tracks || tracks.length <= 1) { btnEl?.classList.add('hidden'); return; }
  btnEl?.classList.remove('hidden');
  if (!listEl) return;
  listEl.innerHTML = '';
  for (let i = 0; i < tracks.length; i++) {
    const item = document.createElement('div');
    item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 transition-colors ${tracks[i].enabled ? 'bg-blue-600 font-semibold' : ''}`;
    item.textContent = tracks[i].label || tracks[i].language || `Track ${i + 1}`;
    item.onclick = () => {
      for (let j = 0; j < tracks.length; j++) tracks[j].enabled = (j === i);
      updateAudioTrackList();
      document.getElementById('audio-track-menu')?.classList.add('hidden');
    };
    listEl.appendChild(item);
  }
}

function updateSubtitleTrackList() {
  const video = UIElements.videoElement;
  const tracks = video.textTracks;
  const listEl = document.getElementById('subtitle-track-list');
  const btnEl = document.getElementById('subtitle-track-btn');
  if (!tracks || tracks.length === 0) { btnEl?.classList.add('hidden'); return; }
  btnEl?.classList.remove('hidden');
  if (!listEl) return;
  listEl.innerHTML = '';
  const anyShowing = Array.from(tracks).some(t => t.mode === 'showing');
  const offItem = document.createElement('div');
  offItem.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 ${!anyShowing ? 'bg-blue-600 font-semibold' : ''}`;
  offItem.textContent = 'Off';
  offItem.onclick = () => {
    for (let i = 0; i < tracks.length; i++) tracks[i].mode = 'hidden';
    updateSubtitleTrackList();
    document.getElementById('subtitle-track-menu')?.classList.add('hidden');
  };
  listEl.appendChild(offItem);
  for (let i = 0; i < tracks.length; i++) {
    const item = document.createElement('div');
    item.className = `px-4 py-2 cursor-pointer hover:bg-gray-700 ${tracks[i].mode === 'showing' ? 'bg-blue-600 font-semibold' : ''}`;
    item.textContent = tracks[i].label || tracks[i].language || `Subtitle ${i + 1}`;
    item.onclick = () => {
      for (let j = 0; j < tracks.length; j++) tracks[j].mode = (j === i) ? 'showing' : 'hidden';
      updateSubtitleTrackList();
      document.getElementById('subtitle-track-menu')?.classList.add('hidden');
    };
    listEl.appendChild(item);
  }
}

// --- Event listeners ---

export function setupPlayerEventListeners() {
  UIElements.closeModal.addEventListener('click', stopAndCleanupPlayer);

  const refreshBtn = document.getElementById('refresh-stream-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', forceRefreshStream);

  UIElements.pipBtn.addEventListener('click', () => {
    if (document.pictureInPictureEnabled && UIElements.videoElement.readyState >= 3) {
      UIElements.videoElement.requestPictureInPicture().catch(() => showNotification('Could not enter PiP.', true));
    }
  });

  UIElements.streamInfoToggleBtn.addEventListener('click', () => {
    UIElements.streamInfoOverlay.classList.toggle('hidden');
  });

  const aspectBtn = document.getElementById('aspect-ratio-lock-btn');
  if (aspectBtn) { aspectBtn.addEventListener('click', toggleAspectRatioLock); updateAspectRatioLockButton(); }

  if (UIElements.castBtn) {
    UIElements.castBtn.addEventListener('click', () => {
      try { cast.framework.CastContext.getInstance().requestSession().catch(() => {}); } catch {}
    });
  }

  UIElements.videoElement.addEventListener('enterpictureinpicture', () => closeModal(UIElements.videoModal));
  UIElements.videoElement.addEventListener('leavepictureinpicture', () => {
    if (appState.player && !UIElements.videoElement.paused) openModal(UIElements.videoModal);
    else stopAndCleanupPlayer();
  });

  UIElements.videoElement.addEventListener('volumechange', () => {
    localStorage.setItem('iptvPlayerVolume', UIElements.videoElement.volume);
  });

  document.getElementById('audio-track-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('audio-track-menu')?.classList.toggle('hidden');
    document.getElementById('subtitle-track-menu')?.classList.add('hidden');
  });

  document.getElementById('subtitle-track-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('subtitle-track-menu')?.classList.toggle('hidden');
    document.getElementById('audio-track-menu')?.classList.add('hidden');
  });

  document.addEventListener('click', () => {
    document.getElementById('audio-track-menu')?.classList.add('hidden');
    document.getElementById('subtitle-track-menu')?.classList.add('hidden');
  });

  UIElements.videoElement.addEventListener('loadedmetadata', () => {
    setTimeout(() => { updateAudioTrackList(); updateSubtitleTrackList(); }, 500);
  });
  UIElements.videoElement.addEventListener('addtrack', () => {
    updateAudioTrackList();
    updateSubtitleTrackList();
  });
}

// --- Aspect ratio ---

let isAspectRatioLocked = true;

export const toggleAspectRatioLock = () => { isAspectRatioLocked = !isAspectRatioLocked; updateAspectRatioLockButton(); };

const updateAspectRatioLockButton = () => {
  const btn = document.getElementById('aspect-ratio-lock-btn');
  if (!btn) return;
  const icon = btn.querySelector('span');
  if (isAspectRatioLocked) {
    btn.classList.add('text-blue-500'); btn.classList.remove('text-gray-400');
    if (icon) { icon.innerHTML = ICONS.lock; icon.setAttribute('data-icon', 'lock'); }
  } else {
    btn.classList.add('text-gray-400'); btn.classList.remove('text-blue-500');
    if (icon) { icon.innerHTML = ICONS.unlock; icon.setAttribute('data-icon', 'unlock'); }
  }
};

export const shouldMaintainAspectRatio = () => isAspectRatioLocked;

export const getVideoAspectRatio = () => {
  if (UIElements.videoElement?.videoWidth && UIElements.videoElement?.videoHeight) {
    return UIElements.videoElement.videoWidth / UIElements.videoElement.videoHeight;
  }
  return 16 / 9;
};
