const statusEl = document.getElementById('status');
const videoInfoEl = document.getElementById('video-info');
const videoTitleEl = document.getElementById('video-title');
const qualitySelect = document.getElementById('quality-select');
const downloadBtn = document.getElementById('download-btn');
const resultEl = document.getElementById('result');

let currentVideo = null;

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

init();
