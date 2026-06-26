// ponytail: in-memory cache clears when the service worker is recycled
const assetCache = new Map();

const WISTIA_JSON = (id) => `https://fast.wistia.com/embed/medias/${id}.json`;
const WISTIA_JSON_NET = (id) => `https://fast.wistia.net/embed/medias/${id}.json`;

const SKIP_TYPES = new Set(['preview', 'storyboard', 'still', 'still_image']);

function parseAssets(json) {
  const raw = json?.media?.assets;
  if (!Array.isArray(raw)) throw new Error('Unexpected Wistia JSON shape');

  return raw
    .filter(a =>
      a.url &&
      a.status === 2 &&
      !SKIP_TYPES.has(a.type) &&
      a.ext !== 'bin'
    )
    .map(a => ({
      quality: a.height ? a.height + 'p' : a.type,
      ext: a.ext || 'mp4',
      url: a.url,
      height: a.height || 0,
      isOriginal: a.type === 'original',
    }))
    .sort((a, b) => {
      if (a.isOriginal !== b.isOriginal) return a.isOriginal ? -1 : 1;
      return b.height - a.height;
    });
}

async function fetchViaPageContext(url) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (u) => fetch(u).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
    args: [url],
  });

  const result = results?.[0];
  if (result?.error) throw new Error(result.error.message || 'Page-context fetch failed');
  return result?.result;
}

async function getWistiaAssets(id) {
  if (assetCache.has(id)) return assetCache.get(id);

  const url = WISTIA_JSON(id);
  const urlNet = WISTIA_JSON_NET(id);

  let json = null;

  // Try direct fetch on .com
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) json = await res.json();
  } catch (_) {}

  // Retry on .net
  if (!json) {
    try {
      const res = await fetch(urlNet, { cache: 'no-store' });
      if (res.ok) json = await res.json();
    } catch (_) {}
  }

  // Fallback: fetch from page context (carries Kajabi session cookies)
  if (!json) {
    json = await fetchViaPageContext(url);
  }

  const assets = parseAssets(json);
  assetCache.set(id, assets);
  return assets;
}

function sanitizeFilename(title) {
  if (!title) return '';
  return title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
}

// Core download dispatcher — shared by single-video and bulk-queue paths.
async function downloadVideoToTab(video, tabId) {
  const base = sanitizeFilename(video.title) || ('kajabi-video-' + video.id);

  if (video.platform === 'wistia') {
    const assets = await getWistiaAssets(video.id);
    const asset = assets[0];
    if (!asset) throw new Error('No downloadable asset found');
    await chrome.downloads.download({ url: asset.url, filename: base + '.' + asset.ext, saveAs: false });
    return { ok: true };
  }

  if (video.platform === 'hls') {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: hlsDownloadInPage,
      args: [{ hlsUrl: video.hlsUrl, downloadUrl: video.downloadUrl, filename: base }],
    });
    const r = results?.[0];
    if (r?.error) return { ok: false, error: r.error.message || 'Script injection error' };
    return r?.result ?? { ok: false, error: 'Unknown HLS error' };
  }

  return { ok: false, error: 'Unknown platform: ' + video.platform };
}

// --- Bulk download queue ---

const BULK_KEY = 'bulkQueue';
const BULK_STATE_KEY = 'bulkState';

async function getBulkState() {
  const data = await chrome.storage.local.get([BULK_KEY, BULK_STATE_KEY]);
  return { queue: data[BULK_KEY] ?? [], state: data[BULK_STATE_KEY] ?? null };
}

async function setBulkState(state) {
  await chrome.storage.local.set({ [BULK_STATE_KEY]: state });
}

async function setQueue(queue) {
  await chrome.storage.local.set({ [BULK_KEY]: queue });
}

// ponytail: sequential only (maxConcurrentTabs=1) — parallel tabs cause missed VIDEO_DETECTED signals
async function runBulkQueue() {
  const { queue } = await getBulkState();
  const total = queue.length;
  let completed = 0;
  let failed = 0;

  for (const lesson of queue) {
    const { state } = await getBulkState();
    if (state?.cancelled) {
      await setBulkState({ active: false, cancelled: false, completed, failed, total });
      return;
    }

    lesson.status = 'downloading';
    await setQueue(queue);
    await setBulkState({ active: true, current: lesson.url, completed, failed, total });

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: lesson.url, active: false });

      const video = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout: no video detected')), 30000);
        const listener = (msg) => {
          if (msg.type === 'VIDEO_DETECTED' && msg.video) {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(msg.video);
          }
        };
        chrome.runtime.onMessage.addListener(listener);
      });

      const result = await downloadVideoToTab(video, tab.id);

      if (result.ok) {
        lesson.status = 'done';
        completed++;
        // ponytail: HLS close-tab delay 3s — Blob assembled but browser write may still be in progress
        if (video.platform === 'hls') await new Promise(r => setTimeout(r, 3000));
      } else {
        lesson.status = 'failed';
        lesson.error = result.error;
        failed++;
      }
    } catch (err) {
      lesson.status = 'failed';
      lesson.error = err.message;
      failed++;
    } finally {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
    }

    await setQueue(queue);
  }

  await setBulkState({ active: false, completed, failed, total });
}

// Self-contained function injected into the page's MAIN world for HLS download.
// Must NOT reference anything defined outside its own body — all helpers live inside it.
// Data is passed in via the args array; it only uses standard web APIs (fetch, URL,
// crypto.subtle, document, Blob).
// ponytail: whole video buffered in page memory; fine for course-length clips
// ponytail: AES-128/AES-CBC only; SAMPLE-AES, DRM, and mid-stream key rotation unsupported
async function hlsDownloadInPage({ hlsUrl, downloadUrl, filename }) {
  function resolveUrl(base, relative) {
    return new URL(relative, base).href;
  }

  function hexToBytes(hex) {
    const b = new Uint8Array(hex.length / 2);
    for (let i = 0; i < b.length; i++) {
      b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return b;
  }

  // Encode a segment media-sequence number as a 16-byte big-endian IV
  function seqToIV(seq) {
    const iv = new Uint8Array(16);
    let n = seq;
    for (let i = 15; i >= 0 && n > 0; i--) {
      iv[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    return iv;
  }

  function triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  try {
    if (downloadUrl) {
      // Direct video download (mp4 or other format indicated by URL extension)
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const urlPath = downloadUrl.split('?')[0];
      const lastDot = urlPath.lastIndexOf('.');
      const ext = (lastDot !== -1 && urlPath.length - lastDot <= 5) ? urlPath.slice(lastDot) : '.mp4';
      triggerDownload(blob, filename + ext);
      return { ok: true };
    }

    if (hlsUrl) {
      // 1. Fetch master playlist; select highest-bandwidth variant if present
      const masterRes = await fetch(hlsUrl);
      if (!masterRes.ok) throw new Error(`HTTP ${masterRes.status} fetching playlist`);
      const masterText = await masterRes.text();

      let mediaPlaylistUrl = hlsUrl;
      let mediaPlaylistText = masterText;

      if (masterText.includes('#EXT-X-STREAM-INF')) {
        const lines = masterText.split('\n');
        let bestBandwidth = -1;
        let bestVariant = null;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith('#EXT-X-STREAM-INF')) {
            const bwMatch = line.match(/BANDWIDTH=(\d+)/);
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const variantLine = lines[i + 1]?.trim();
            if (variantLine && !variantLine.startsWith('#') && bw > bestBandwidth) {
              bestBandwidth = bw;
              bestVariant = variantLine;
            }
          }
        }
        if (!bestVariant) throw new Error('No variant streams found in master playlist');
        mediaPlaylistUrl = resolveUrl(hlsUrl, bestVariant);
        const mediaRes = await fetch(mediaPlaylistUrl);
        if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status} fetching media playlist`);
        mediaPlaylistText = await mediaRes.text();
      }

      // 2. Parse media playlist for init segment, encryption key, and segment URLs
      const lines = mediaPlaylistText.split('\n');
      let initSegmentUrl = null;
      let keyUrl = null;
      let keyIV = null;      // hex string, 32 chars = 16 bytes, or null (use seq number)
      let mediaSequence = 0;
      const segments = []; // { url, seq }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
          mediaSequence = parseInt(line.split(':')[1], 10) || 0;
        } else if (line.startsWith('#EXT-X-MAP:')) {
          const uriMatch = line.match(/URI="([^"]+)"/);
          if (uriMatch) initSegmentUrl = resolveUrl(mediaPlaylistUrl, uriMatch[1]);
        } else if (line.startsWith('#EXT-X-KEY:')) {
          const methodMatch = line.match(/METHOD=([^,\s]+)/);
          const method = methodMatch ? methodMatch[1] : '';
          if (method === 'NONE') {
            keyUrl = null; keyIV = null;
          } else if (method === 'AES-128') {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) keyUrl = resolveUrl(mediaPlaylistUrl, uriMatch[1]);
            const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/i);
            keyIV = ivMatch ? ivMatch[1].padStart(32, '0') : null;
          } else {
            return { ok: false, error: `Unsupported HLS encryption: ${method}` };
          }
        } else if (!line.startsWith('#')) {
          segments.push({ url: resolveUrl(mediaPlaylistUrl, line), seq: mediaSequence + segments.length });
        }
      }

      // 3. Import AES-128 decryption key if stream is encrypted
      let cryptoKey = null;
      if (keyUrl) {
        const keyRes = await fetch(keyUrl);
        if (!keyRes.ok) throw new Error(`HTTP ${keyRes.status} fetching AES key`);
        const keyBytes = await keyRes.arrayBuffer();
        cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['decrypt']);
      }

      // 4. Fetch fMP4 init segment (if any) then all media segments sequentially
      const parts = [];

      if (initSegmentUrl) {
        const initRes = await fetch(initSegmentUrl);
        if (!initRes.ok) throw new Error(`HTTP ${initRes.status} fetching init segment`);
        parts.push(await initRes.arrayBuffer());
      }

      for (const seg of segments) {
        const segRes = await fetch(seg.url);
        if (!segRes.ok) throw new Error(`HTTP ${segRes.status} fetching segment`);
        let segBytes = await segRes.arrayBuffer();
        if (cryptoKey) {
          // IV: use explicit playlist value if given, else big-endian media sequence number
          const iv = keyIV ? hexToBytes(keyIV) : seqToIV(seg.seq);
          segBytes = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, segBytes);
        }
        parts.push(segBytes);
      }

      // 5. Determine container format
      //    fMP4 (CMAF) when an init segment was present; otherwise sniff the first byte:
      //    0x47 = MPEG-TS sync byte → raw TS concat (directly playable, do NOT mislabel as .mp4)
      let ext;
      if (initSegmentUrl) {
        ext = '.mp4'; // fMP4 / CMAF
      } else if (parts.length > 0) {
        const first = new Uint8Array(parts[0]);
        ext = (first[0] === 0x47) ? '.ts' : '.mp4';
      } else {
        ext = '.mp4';
      }

      // 6. Assemble Blob and trigger <a download> click
      const mimeType = ext === '.ts' ? 'video/mp2t' : 'video/mp4';
      const blob = new Blob(parts, { type: mimeType });
      triggerDownload(blob, filename + ext);
      return { ok: true, segmentCount: segments.length };
    }

    return { ok: false, error: 'No hlsUrl or downloadUrl provided' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ponytail: detectedVideo is a single global key (not per-tab); fine for one-course-at-a-time use
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'VIDEO_DETECTED') {
    chrome.storage.local.set({ detectedVideo: msg.video });
    return; // fire-and-forget, no response needed
  }

  if (msg.type === 'GET_DETECTED') {
    chrome.storage.local.get('detectedVideo', ({ detectedVideo }) => {
      sendResponse({ video: detectedVideo ?? null });
    });
    return true;
  }

  if (msg.type === 'GET_QUALITIES') {
    getWistiaAssets(msg.video.id)
      .then(assets => {
        sendResponse({
          qualities: assets.map((a, i) => ({
            label: a.quality + (a.isOriginal ? ' (original)' : ''),
            index: i,
          })),
        });
      })
      .catch(err => sendResponse({ qualities: [], error: err.message }));
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    const { video, qualityIndex = 0 } = msg;
    (async () => {
      try {
        // Quality selection only applies to Wistia — use dedicated path to preserve saveAs: true
        if (video.platform === 'wistia') {
          const base = sanitizeFilename(video.title) || ('kajabi-video-' + video.id);
          const assets = await getWistiaAssets(video.id);
          const asset = assets[qualityIndex] ?? assets[0];
          if (!asset) throw new Error('No downloadable asset found');
          await chrome.downloads.download({ url: asset.url, filename: base + '.' + asset.ext, saveAs: true });
          sendResponse({ ok: true });
          return;
        }
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ ok: false, error: 'No active tab' }); return; }
        const result = await downloadVideoToTab(video, tab.id);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'START_BULK_DOWNLOAD') {
    const queue = msg.lessons.map(l => ({ ...l, status: 'pending' }));
    setQueue(queue).then(() =>
      setBulkState({ active: true, completed: 0, failed: 0, total: queue.length, current: null })
    ).then(() => {
      sendResponse({ ok: true });
      runBulkQueue();
    });
    return true;
  }

  if (msg.type === 'GET_BULK_STATUS') {
    getBulkState().then(data => sendResponse(data));
    return true;
  }

  if (msg.type === 'CANCEL_BULK_DOWNLOAD') {
    getBulkState().then(async ({ state }) => {
      await setBulkState({ ...(state ?? {}), cancelled: true });
      sendResponse({ ok: true });
    });
    return true;
  }
});
