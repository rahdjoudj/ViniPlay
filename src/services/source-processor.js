/**
 * source-processor.js
 *
 * Fetches, parses, and merges M3U/EPG sources into the live channel guide.
 * Extracted from the original server.cjs (lost during refactoring).
 */
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';
import { logger } from '../config/logger.js';
import {
  SOURCES_DIR, RAW_CACHE_DIR,
  LIVE_CHANNELS_M3U_PATH, LIVE_EPG_JSON_PATH,
} from '../config/index.js';
import { sendSseEvent } from '../routes/_sse-utils.js';

const require = createRequire(import.meta.url);
const xmlJS = require('xml-js');

// --- HTTP fetch with redirects ---

function fetchUrlContent(url, options = {}, asBuffer = false) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const TIMEOUT = 60000;
    logger.debug({ url: url.slice(0, 120) }, '[source-processor] Fetching URL');

    const request = protocol.get(url, { timeout: TIMEOUT, ...options }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        logger.debug({ redirect: res.headers.location }, '[source-processor] Redirecting');
        request.destroy();
        return fetchUrlContent(new URL(res.headers.location, url).href, options, asBuffer).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to fetch: Status Code ${res.statusCode}`));
      }

      if (asBuffer) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Request timed out after ${TIMEOUT / 1000}s`));
    });
    request.on('error', (err) => reject(err));
  });
}

// --- EPG time parsing ---

function parseEpgTime(timeStr, offsetHours = 0) {
  const match = timeStr.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(([+-])(\d{2})(\d{2}))?/);
  if (!match) return new Date();

  const [, year, month, day, hours, minutes, seconds, , sign, tzHours, tzMinutes] = match;
  let date;
  if (sign && tzHours && tzMinutes) {
    const offsetMin = (parseInt(tzHours) * 60 + parseInt(tzMinutes)) * (sign === '+' ? 1 : -1);
    date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
    date.setUTCMinutes(date.getUTCMinutes() - offsetMin);
  } else {
    date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
    date.setUTCHours(date.getUTCHours() - offsetHours);
  }
  return date;
}

// --- SSE status broadcast ---

function sendStatus(sseClients, userId, message, type = 'info') {
  if (!userId) return;
  sendSseEvent(sseClients, userId, 'processing-status', { message, type });
  if (type === 'error') {
    logger.error({ message }, '[source-processor]');
  } else {
    logger.info({ message }, '[source-processor]');
  }
}

// --- Main processing function ---

export async function processAndMergeSources({ getSettings, sseClients, userId = null }) {
  logger.info('[source-processor] Starting to process all active sources');
  if (userId) sendStatus(sseClients, userId, 'Starting to process sources...', 'info');

  const settings = getSettings();
  let mergedLiveM3uContent = '#EXTM3U\n';
  const liveChannelIdSet = new Set();
  const groupTitleRegex = /group-title="([^"]*)"/;

  const activeM3uSources = (settings.m3uSources || []).filter(s => s.isActive);
  const activeEpgSources = (settings.epgSources || []).filter(s => s.isActive);

  if (activeM3uSources.length === 0) {
    logger.info('[source-processor] No active M3U sources found');
    if (userId) sendStatus(sseClients, userId, 'No active M3U sources found.', 'info');
  }

  // --- Process M3U sources ---
  for (const source of activeM3uSources) {
    logger.info({ name: source.name, id: source.id, type: source.type }, '[source-processor] Processing M3U source');
    if (userId) sendStatus(sseClients, userId, `Processing M3U source: "${source.name}"...`, 'info');

    const selectedGroups = source.selectedGroups || [];
    const isGroupFilteringActive = selectedGroups.length > 0;

    try {
      let content = '';
      let sourcePathForLog = source.path;
      let m3uFetchOptions = {};

      if (source.type === 'file') {
        const sourceFilePath = path.join(SOURCES_DIR, path.basename(source.path));
        if (fs.existsSync(sourceFilePath)) {
          content = fs.readFileSync(sourceFilePath, 'utf-8');
          sourcePathForLog = sourceFilePath;
        } else {
          source.status = 'Error';
          source.statusMessage = 'File not found.';
          if (userId) sendStatus(sseClients, userId, `Error: File not found for "${source.name}".`, 'error');
          continue;
        }
      } else if (source.type === 'url') {
        if (userId) sendStatus(sseClients, userId, ' -> Fetching content from URL...', 'info');
        content = await fetchUrlContent(source.path);
        try {
          const cacheFileName = `raw_${source.id}.m3u_cache`;
          const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);
          if (!fs.existsSync(RAW_CACHE_DIR)) fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
          fs.writeFileSync(cacheFilePath, content);
          source.cachedRawPath = cacheFilePath;
        } catch (cacheErr) {
          logger.warn({ err: cacheErr.message }, '[source-processor] Failed to cache raw content');
          delete source.cachedRawPath;
        }
        if (userId) sendStatus(sseClients, userId, ' -> Successfully fetched M3U content.', 'info');
      } else if (source.type === 'xc') {
        if (!source.xc_data) throw new Error('XC source is missing credential data');
        const xcInfo = typeof source.xc_data === 'string' ? JSON.parse(source.xc_data) : source.xc_data;
        const { server, username, password } = xcInfo;

        if (!server || !username || !password) {
          throw new Error('XC source is missing server, username, or password.');
        }

        const activeUserAgent = (settings.userAgents || []).find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0';
        m3uFetchOptions = { headers: { 'User-Agent': activeUserAgent } };

        const liveStreamsUrl = `${server.replace(/\/+$/, '')}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
        const liveCategoriesUrl = `${server.replace(/\/+$/, '')}/player_api.php?username=${username}&password=${password}&action=get_live_categories`;

        try {
          if (userId) sendStatus(sseClients, userId, ' -> Fetching live categories from XC server...', 'info');
          const liveCategoriesRaw = await fetchUrlContent(liveCategoriesUrl, m3uFetchOptions);
          const liveCategories = JSON.parse(liveCategoriesRaw);

          if (userId) sendStatus(sseClients, userId, ' -> Fetching live streams from XC server...', 'info');
          const liveStreamsRaw = await fetchUrlContent(liveStreamsUrl, m3uFetchOptions);
          const liveStreams = JSON.parse(liveStreamsRaw);

          let liveM3uContent = '';
          let liveStreamCount = 0;

          if (Array.isArray(liveStreams)) {
            for (const stream of liveStreams) {
              if (stream.stream_type === 'live') {
                liveStreamCount++;
                const streamUrl = `${server.replace(/\/+$/, '')}/live/${username}/${password}/${stream.stream_id}.ts`;
                const categoryName = Array.isArray(liveCategories)
                  ? liveCategories.find(cat => cat.category_id == stream.category_id)?.category_name || 'Live'
                  : 'Live';
                const tvgId = stream.epg_channel_id || stream.stream_id;

                liveM3uContent += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${stream.name}" tvg-logo="${stream.stream_icon || ''}" group-title="${categoryName}",${stream.name}\n`;
                liveM3uContent += `${streamUrl}\n`;
              }
            }
          }

          if (liveStreamCount > 0) {
            content += '\n' + liveM3uContent;
            if (userId) sendStatus(sseClients, userId, ` -> Added ${liveStreamCount} live streams.`, 'info');
          } else {
            if (userId) sendStatus(sseClients, userId, ' -> No live streams found.', 'info');
          }
        } catch (liveErr) {
          logger.error({ err: liveErr.message, source: source.name }, '[source-processor] XC live stream fetch failed');
          if (userId) sendStatus(sseClients, userId, ` -> Warning: Could not fetch live streams: ${liveErr.message}`, 'warning');
        }

        // Cache XC content
        try {
          const cacheFileName = `raw_${source.id}.m3u_cache`;
          const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);
          if (!fs.existsSync(RAW_CACHE_DIR)) fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
          fs.writeFileSync(cacheFilePath, content);
          source.cachedRawPath = cacheFilePath;
        } catch (cacheErr) {
          logger.warn({ err: cacheErr.message }, '[source-processor] Failed to cache XC content');
          delete source.cachedRawPath;
        }

        sourcePathForLog = liveStreamsUrl;
        if (userId) sendStatus(sseClients, userId, ' -> Successfully fetched from XC server.', 'info');
      }

      // Parse M3U lines into merged content
      const lines = content.split('\n');
      let currentExtInf = '';
      let liveStreamCount = 0;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('#EXTINF:')) {
          currentExtInf = line;
          continue;
        }

        if (line.startsWith('http') && currentExtInf) {
          const streamUrl = line;

          // Group filter
          const groupMatch = currentExtInf.match(groupTitleRegex);
          const groupTitle = groupMatch?.[1] || 'Uncategorized';
          if (isGroupFilteringActive && !selectedGroups.includes(groupTitle)) {
            currentExtInf = '';
            continue;
          }

          liveStreamCount++;
          let processedExtInf = currentExtInf;
          const idMatch = currentExtInf.match(/tvg-id="([^"]*)"/);
          const nameMatch = currentExtInf.match(/tvg-name="([^"]*)"/);
          const commaIndex = currentExtInf.lastIndexOf(',');
          const chanName = nameMatch ? nameMatch[1] : ((commaIndex !== -1) ? currentExtInf.substring(commaIndex + 1).trim() : 'Unknown');

          const originalTvgId = idMatch ? idMatch[1] : `no-tvg-id-${chanName.replace(/[^a-zA-Z0-9]/g, '')}`;
          const finalUniqueChannelId = `${source.id}_${originalTvgId}`;

          if (idMatch) {
            processedExtInf = processedExtInf.replace(/tvg-id="[^"]*"/, `tvg-id="${finalUniqueChannelId}"`);
          } else {
            const extinfEnd = processedExtInf.indexOf(':') + 1;
            processedExtInf = processedExtInf.slice(0, extinfEnd) + ` tvg-id="${finalUniqueChannelId}"` + processedExtInf.slice(extinfEnd);
          }

          const tvgIdAttrEnd = processedExtInf.indexOf(`tvg-id="${finalUniqueChannelId}"`) + `tvg-id="${finalUniqueChannelId}"`.length;
          processedExtInf = processedExtInf.slice(0, tvgIdAttrEnd) + ` vini-source="${source.name}"` + processedExtInf.slice(tvgIdAttrEnd);

          mergedLiveM3uContent += processedExtInf + '\n' + streamUrl + '\n';
          liveChannelIdSet.add(finalUniqueChannelId);
          currentExtInf = '';
        }
      }

      source.status = 'Success';
      source.statusMessage = `Processed ${liveStreamCount} Live channels.`;
      logger.info({ name: source.name, liveChannels: liveStreamCount }, '[source-processor] M3U source processed');
      if (userId) sendStatus(sseClients, userId, ` -> Processed ${liveStreamCount} Live channels from "${source.name}".`, 'info');

    } catch (error) {
      logger.error({ err: error.message, source: source.name }, '[source-processor] M3U source failed');
      if (userId) sendStatus(sseClients, userId, `Error: Failed to process "${source.name}": ${error.message.slice(0, 100)}`, 'error');
      source.status = 'Error';
      source.statusMessage = `Processing failed: ${error.message.slice(0, 100)}`;
    }
    source.lastUpdated = new Date().toISOString();
  }

  // --- Save merged M3U ---
  try {
    fs.writeFileSync(LIVE_CHANNELS_M3U_PATH, mergedLiveM3uContent);
    logger.info({ path: LIVE_CHANNELS_M3U_PATH }, '[source-processor] Merged M3U saved');
    if (userId) sendStatus(sseClients, userId, 'Successfully merged all live channels.', 'success');
  } catch (writeErr) {
    logger.error({ err: writeErr.message }, '[source-processor] Failed to write M3U file');
  }

  // --- Process EPG sources ---
  const mergedProgramData = {};
  const timezoneOffset = settings.timezoneOffset || 0;

  if (activeEpgSources.length === 0) {
    logger.info('[source-processor] No active EPG sources');
  }

  for (const source of activeEpgSources) {
    logger.info({ name: source.name, id: source.id }, '[source-processor] Processing EPG source');
    if (userId) sendStatus(sseClients, userId, `Processing EPG source: "${source.name}"...`, 'info');

    try {
      let xmlString = '';
      const epgFilePath = path.join(SOURCES_DIR, `epg_${source.id}.xml`);

      if (source.type === 'file') {
        if (fs.existsSync(source.path)) {
          xmlString = fs.readFileSync(source.path, 'utf-8');
        } else {
          source.status = 'Error';
          source.statusMessage = 'File not found.';
          continue;
        }
      } else if (source.type === 'url') {
        if (userId) sendStatus(sseClients, userId, ' -> Fetching EPG content...', 'info');
        if (source.path.endsWith('.gz')) {
          const buffer = await fetchUrlContent(source.path, source.fetchOptions || {}, true);
          xmlString = zlib.gunzipSync(buffer).toString('utf-8');
        } else {
          xmlString = await fetchUrlContent(source.path, source.fetchOptions || {});
        }
        try { fs.writeFileSync(epgFilePath, xmlString); } catch {}
      }

      const epgJson = xmlJS.xml2js(xmlString, { compact: true });
      const programs = epgJson.tv?.programme ? [].concat(epgJson.tv.programme) : [];
      let programCount = 0;
      let epgAddedCount = 0;

      const m3uSourceProviders = (settings.m3uSources || []).filter(m3u => m3u.isActive);

      for (const prog of programs) {
        const originalChannelId = prog._attributes?.channel;
        if (!originalChannelId) continue;
        programCount++;

        for (const m3uSource of m3uSourceProviders) {
          const uniqueChannelId = `${m3uSource.id}_${originalChannelId}`;
          if (!liveChannelIdSet.has(uniqueChannelId)) continue;

          if (!mergedProgramData[uniqueChannelId]) mergedProgramData[uniqueChannelId] = [];
          epgAddedCount++;

          const titleNode = prog.title?._cdata || prog.title?._text || 'No Title';
          const descNode = prog.desc?._cdata || prog.desc?._text || '';

          mergedProgramData[uniqueChannelId].push({
            start: parseEpgTime(prog._attributes.start, timezoneOffset).toISOString(),
            stop: parseEpgTime(prog._attributes.stop, timezoneOffset).toISOString(),
            title: titleNode.trim(),
            desc: descNode.trim(),
          });
        }
      }

      if (!source.isXcEpg) {
        source.status = 'Success';
        source.statusMessage = `Processed ${programCount} programs, added ${epgAddedCount} to guide.`;
      }
      if (userId) sendStatus(sseClients, userId, ` -> Processed ${programCount} programs, added ${epgAddedCount} from "${source.name}".`, 'info');

    } catch (error) {
      logger.error({ err: error.message, source: source.name }, '[source-processor] EPG source failed');
      if (userId) sendStatus(sseClients, userId, `Error: ${error.message.slice(0, 100)}`, 'error');
      if (!source.isXcEpg) {
        source.status = 'Error';
        source.statusMessage = `Processing failed: ${error.message.slice(0, 100)}`;
      }
    }
    if (!source.isXcEpg) source.lastUpdated = new Date().toISOString();
  }

  // Sort programs by start time
  for (const channelId in mergedProgramData) {
    mergedProgramData[channelId].sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  // --- Save EPG JSON ---
  try {
    fs.writeFileSync(LIVE_EPG_JSON_PATH, JSON.stringify(mergedProgramData));
    logger.info({ path: LIVE_EPG_JSON_PATH, channels: Object.keys(mergedProgramData).length }, '[source-processor] EPG JSON saved');
    if (userId) sendStatus(sseClients, userId, 'Successfully merged all EPG data.', 'success');
  } catch (writeErr) {
    logger.error({ err: writeErr.message }, '[source-processor] Failed to write EPG file');
  }

  settings.sourcesLastUpdated = new Date().toISOString();
  if (userId) sendStatus(sseClients, userId, 'All sources processed successfully!', 'final_success');

  logger.info('[source-processor] Finished processing all sources');
  return { success: true, updatedSettings: settings };
}

// --- Scheduler ---

const sourceRefreshTimers = new Map();

export function updateAndScheduleSourceRefreshes({ getSettings, saveSettings, sseClients }) {
  logger.info('[scheduler] Updating source refresh schedule');
  const settings = getSettings();
  const allSources = [...(settings.m3uSources || []), ...(settings.epgSources || [])];
  const activeUrlSources = new Set();

  for (const source of allSources) {
    if (source.type === 'url' && source.isActive && source.refreshHours > 0) {
      activeUrlSources.add(source.id);
      if (sourceRefreshTimers.has(source.id)) clearTimeout(sourceRefreshTimers.get(source.id));

      logger.info({ name: source.name, intervalH: source.refreshHours }, '[scheduler] Scheduling auto-refresh');

      const scheduleNext = () => {
        const timeoutId = setTimeout(async () => {
          logger.info({ name: source.name }, '[scheduler] Auto-refresh triggered');
          try {
            const result = await processAndMergeSources({ getSettings, sseClients, userId: null });
            if (result?.success) {
              saveSettings(result.updatedSettings);
              logger.info({ name: source.name }, '[scheduler] Auto-refresh completed');
            }
          } catch (error) {
            logger.error({ err: error.message, name: source.name }, '[scheduler] Auto-refresh failed');
          }
          scheduleNext();
        }, source.refreshHours * 3600 * 1000);
        timeoutId.unref();
        sourceRefreshTimers.set(source.id, timeoutId);
      };
      scheduleNext();
    }
  }

  // Clear stale timers
  for (const [sourceId, timeoutId] of sourceRefreshTimers.entries()) {
    if (!activeUrlSources.has(sourceId)) {
      clearTimeout(timeoutId);
      sourceRefreshTimers.delete(sourceId);
    }
  }
  logger.info({ activeTimers: sourceRefreshTimers.size }, '[scheduler] Refresh schedule updated');
}

export { sourceRefreshTimers };
