const statusEl = document.getElementById('status');
const videoInfoEl = document.getElementById('video-info');
const videoTitleEl = document.getElementById('video-title');
const qualitySelect = document.getElementById('quality-select');
const downloadBtn = document.getElementById('download-btn');
const resultEl = document.getElementById('result');

const bulkInfoEl = document.getElementById('bulk-info');
const bulkCourseLabel = document.getElementById('bulk-course-label');
const bulkProgressText = document.getElementById('bulk-progress-text');
const bulkBar = document.getElementById('bulk-bar');
const bulkList = document.getElementById('bulk-list');
const bulkStartBtn = document.getElementById('bulk-start-btn');
const bulkCancelBtn = document.getElementById('bulk-cancel-btn');
const bulkResultEl = document.getElementById('bulk-result');

let currentVideo = null;
let discoveredLessons = [];
let pollTimer = null;

function showError(msg) {
  resultEl.textContent = msg;
  resultEl.className = 'error';
}

function showOk(msg) {
  resultEl.textContent = msg;
  resultEl.className = 'ok';
}

async function sendMsg(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function updateBulkProgress({ queue = [], state = {} }) {
  const total = state.total ?? queue.length;
  const completed = state.completed ?? 0;
  const failed = state.failed ?? 0;
  const pct = total ? Math.round((completed + failed) / total * 100) : 0;

  bulkProgressText.textContent = `${completed} of ${total} downloaded${failed ? ` (${failed} failed)` : ''}`;
  bulkBar.value = pct;

  bulkList.innerHTML = queue.map(l => {
    const icon = l.status === 'done' ? '✓' : l.status === 'failed' ? '✗' : l.status === 'downloading' ? '…' : '○';
    const color = l.status === 'done' ? '#2e7d32' : l.status === 'failed' ? '#c62828' : '#555';
    return `<li style="padding:2px 0;color:${color}">${icon} ${l.title || l.url}</li>`;
  }).join('');

  if (!state.active) {
    clearInterval(pollTimer);
    pollTimer = null;
    bulkStartBtn.style.display = 'block';
    bulkCancelBtn.style.display = 'none';
    if (total > 0) {
      bulkResultEl.textContent = `Done — ${completed} downloaded, ${failed} failed.`;
      bulkResultEl.style.color = failed ? '#c62828' : '#2e7d32';
    }
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const data = await sendMsg({ type: 'GET_BULK_STATUS' });
    updateBulkProgress(data);
  }, 800);
}

async function init() {
  const { video } = await sendMsg({ type: 'GET_DETECTED' });

  if (!video) {
    statusEl.textContent = 'No Kajabi video detected on this page.';
    return;
  }

  currentVideo = video;
  statusEl.style.display = 'none';
  videoInfoEl.style.display = 'block';
  videoTitleEl.textContent = video.title || video.id;

  // ponytail: only Wistia has selectable quality assets; HLS is a single stream
  if (video.platform !== 'wistia') {
    qualitySelect.style.display = 'none';
    return;
  }

  const { qualities, error } = await sendMsg({ type: 'GET_QUALITIES', video });

  if (error || !qualities?.length) {
    showError('Could not load qualities: ' + (error || 'no assets found'));
    downloadBtn.disabled = true;
    return;
  }

  qualitySelect.innerHTML = '';
  for (const q of qualities) {
    const opt = document.createElement('option');
    opt.value = q.index;
    opt.textContent = q.label;
    qualitySelect.appendChild(opt);
  }
  // Default selects index 0 (best) — first option is already selected

  // Check if there are multiple lesson links on this page → switch to bulk mode
  const [tab] = await new Promise(resolve =>
    chrome.tabs.query({ active: true, currentWindow: true }, resolve)
  );
  if (!tab?.id) return;

  let lessonsResp = null;
  try {
    lessonsResp = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_LESSON_URLS' }, resp => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(resp);
      });
    });
  } catch (_) {}

  if (lessonsResp?.lessons?.length > 1) {
    discoveredLessons = lessonsResp.lessons;
    videoInfoEl.style.display = 'none';
    statusEl.style.display = 'none';
    bulkInfoEl.style.display = 'block';
    bulkCourseLabel.textContent = `${discoveredLessons.length} lessons found on this page`;

    const existing = await sendMsg({ type: 'GET_BULK_STATUS' });
    if (existing?.state?.active) {
      bulkStartBtn.style.display = 'none';
      bulkCancelBtn.style.display = 'block';
      updateBulkProgress(existing);
      startPolling();
    }
  }
}

downloadBtn.addEventListener('click', async () => {
  if (!currentVideo) return;
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Starting…';
  resultEl.textContent = '';
  resultEl.className = '';

  const qualityIndex = parseInt(qualitySelect.value, 10);
  const resp = await sendMsg({ type: 'DOWNLOAD', video: currentVideo, qualityIndex });

  downloadBtn.disabled = false;
  downloadBtn.textContent = 'Download';

  if (resp?.ok) {
    showOk('Download started.');
  } else {
    showError(resp?.error || 'Download failed.');
  }
});

bulkStartBtn.addEventListener('click', async () => {
  if (!discoveredLessons.length) return;
  bulkStartBtn.style.display = 'none';
  bulkCancelBtn.style.display = 'block';
  bulkResultEl.textContent = '';
  await sendMsg({ type: 'START_BULK_DOWNLOAD', lessons: discoveredLessons });
  startPolling();
});

bulkCancelBtn.addEventListener('click', async () => {
  await sendMsg({ type: 'CANCEL_BULK_DOWNLOAD' });
  bulkCancelBtn.style.display = 'none';
  bulkStartBtn.style.display = 'block';
  bulkResultEl.textContent = 'Cancelled.';
  bulkResultEl.style.color = '#555';
  clearInterval(pollTimer);
  pollTimer = null;
});

init();
