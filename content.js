(() => {
  // Guard: only run once per frame context
  if (window.__kajabi_downloader_active) return;
  window.__kajabi_downloader_active = true;

  const HASH_RE = /[a-z0-9]{10}/;
  const IFRAME_RE = /(?:embed\/(?:iframe|medias)\/|wmediaid=)([a-z0-9]{10})/;
  const SOURCE_RE = /(?:medias|embed)\/([a-z0-9]{10})/;
  const ASYNC_CLASS_RE = /wistia_async_([a-z0-9]{10})/;
  const SCRIPT_RE = /wistia.*?["'\/]([a-z0-9]{10})["'\/ ]/i;

  let currentId = null;
  let button = null;

  function extractTitle() {
    const selectors = [
      'main h1', 'main h2', '.lesson-title', '.post-title',
      'article h1', 'article h2', 'h1', 'h2'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return el.textContent.trim().replace(/\s*[|\-–—].*$/, '').trim();
      }
    }
    return document.title.replace(/\s*[|\-–—].*$/, '').trim();
  }

  function detectWistiaId() {
    // 1. iframe[src*="wistia"]
    for (const iframe of document.querySelectorAll('iframe[src*="wistia"]')) {
      const m = iframe.src.match(IFRAME_RE);
      if (m) return m[1];
    }

    // 2. source[src*="wistia"] or source[src*="fast.wistia"]
    for (const src of document.querySelectorAll('source[src*="wistia"], source[src*="fast.wistia"]')) {
      const m = src.src.match(SOURCE_RE);
      if (m) return m[2] || m[1];
    }

    // 3. data attributes and class patterns
    for (const el of document.querySelectorAll('[data-wistia-id]')) {
      const v = el.getAttribute('data-wistia-id');
      if (v && HASH_RE.test(v)) return v.match(HASH_RE)[0];
    }
    for (const el of document.querySelectorAll('[data-wistia-video-id]')) {
      const v = el.getAttribute('data-wistia-video-id');
      if (v && HASH_RE.test(v)) return v.match(HASH_RE)[0];
    }
    for (const el of document.querySelectorAll('[class*="wistia_async_"], [class*="wistia_embed"]')) {
      for (const cls of el.classList) {
        const m = cls.match(ASYNC_CLASS_RE);
        if (m) return m[1];
      }
    }

    // 4. Last resort: script text scan
    for (const script of document.querySelectorAll('script')) {
      const m = script.textContent.match(SCRIPT_RE);
      if (m) return m[1];
    }

    return null;
  }

  // HLS / Kajabi native player detection
  // Recursively searches a root (document or shadow root) for <media-theme>,
  // <hls-video>, or <video> elements, diving into shadow DOM as needed.
  function findHlsCandidate(root) {
    const CANDIDATE_ATTRS = ['downloadurl', 'src', 'playbacksrc', 'data-src', 'data-playback-src'];
    const elements = Array.from(root.querySelectorAll('media-theme, hls-video, video'));
    for (const el of elements) {
      // Traverse shadow DOM first — Kajabi wraps the real player inside a shadow root
      if (el.shadowRoot) {
        const inner = findHlsCandidate(el.shadowRoot);
        if (inner) return inner;
      }
      // downloadurl attribute takes priority: it's a direct video link (e.g. mp4)
      const dlUrl = el.getAttribute('downloadurl');
      if (dlUrl) return { downloadUrl: dlUrl, hlsUrl: null };
      // Any other attribute containing .m3u8 gives us an HLS playlist URL
      for (const attr of CANDIDATE_ATTRS) {
        if (attr === 'downloadurl') continue;
        const val = el.getAttribute(attr);
        if (val && val.includes('.m3u8')) return { downloadUrl: null, hlsUrl: val };
      }
    }
    return null;
  }

  function detectHlsVideo() {
    const found = findHlsCandidate(document);
    if (!found) return null;
    // Derive a stable-ish id from the last path segment of the URL (without extension)
    const url = found.hlsUrl || found.downloadUrl || '';
    const lastSegment = url.split('?')[0].split('/').filter(Boolean).pop() || '';
    const id = lastSegment.replace(/\.[^.]+$/, '') || ('hls-' + Math.random().toString(36).slice(2, 8));
    return {
      platform: 'hls',
      id,
      title: extractTitle(),
      hlsUrl: found.hlsUrl,
      downloadUrl: found.downloadUrl,
    };
  }

  function removeButton() {
    if (button && button.parentNode) {
      button.parentNode.removeChild(button);
    }
    button = null;
  }

  function injectButton(video) {
    removeButton();

    button = document.createElement('button');
    button.textContent = '⬇ Download';
    Object.assign(button.style, {
      position: 'fixed',
      top: '12px',
      right: '12px',
      zIndex: '2147483647',
      padding: '8px 14px',
      background: '#1a73e8',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      fontFamily: 'system-ui, sans-serif',
    });

    button.addEventListener('click', () => {
      button.textContent = 'Downloading…';
      button.disabled = true;
      chrome.runtime.sendMessage({ type: 'DOWNLOAD', video, qualityIndex: 0 }, () => {
        setTimeout(() => {
          if (button) {
            button.textContent = '⬇ Download';
            button.disabled = false;
          }
        }, 2500);
      });
    });

    document.body.appendChild(button);
  }

  function runDetection() {
    // Phase 1: Wistia (existing behavior — always tried first)
    const wistiaId = detectWistiaId();
    if (wistiaId) {
      if (wistiaId === currentId) return;
      currentId = wistiaId;
      const video = {
        platform: 'wistia',
        id: wistiaId,
        title: extractTitle(),
        hlsUrl: null,
        downloadUrl: null,
      };
      chrome.runtime.sendMessage({ type: 'VIDEO_DETECTED', video });
      injectButton(video);
      return;
    }

    // Phase 2: Kajabi native HLS player (only if no Wistia found)
    const hlsVideo = detectHlsVideo();
    if (!hlsVideo) {
      // No video found — if we had one before, leave the button (user may want it)
      return;
    }
    if (hlsVideo.id === currentId) return;
    currentId = hlsVideo.id;
    chrome.runtime.sendMessage({ type: 'VIDEO_DETECTED', video: hlsVideo });
    injectButton(hlsVideo);
  }

  // Initial detection
  runDetection();

  // Debounced MutationObserver for SPA navigation
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runDetection, 600);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Scan all anchor tags for Kajabi lesson links.
  // Uses href pattern instead of CSS classes — stable across Kajabi UI changes.
  function extractLessonUrls() {
    const seen = new Set();
    return [...document.querySelectorAll('a[href*="/lessons/"], a[href*="/posts/"]')]
      .map(a => ({
        url: new URL(a.href, location.href).href,
        title: a.textContent.trim() || a.href.split('/').pop(),
      }))
      .filter(({ url }) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_LESSON_URLS') {
      sendResponse({ lessons: extractLessonUrls() });
    }
  });
})();
