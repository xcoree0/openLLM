// ==========================================================================
// video.js — video üretim stüdyosu (senkron/asenkron NVCF akışı dahil)
// ==========================================================================
import { Runtime } from './runtime.js';
import { fullVideoCatalog, addCustomModel } from './catalog.js';
import { toast, openModal, setSignalActive, downloadBase64, randomSeed, fileToBase64, escapeHtml, describeError } from './ui.js';
import { extractVideo } from './api.js';


const els = {
  list: document.getElementById('video-model-list'),
  addCustom: document.getElementById('video-add-custom'),
  inputModeToggle: document.getElementById('video-input-mode'),
  textFields: document.getElementById('video-text-fields'),
  imageFields: document.getElementById('video-image-fields'),
  prompt: document.getElementById('video-prompt'),
  dropzone: document.getElementById('video-dropzone'),
  imageInput: document.getElementById('video-image-input'),
  imagePreview: document.getElementById('video-image-preview'),
  cfg: document.getElementById('video-cfg'),
  cfgOut: document.getElementById('video-cfg-out'),
  seed: document.getElementById('video-seed'),
  seedRandom: document.getElementById('video-seed-random'),
  rawJson: document.getElementById('video-raw-json'),
  generate: document.getElementById('video-generate'),
  status: document.getElementById('video-status'),
  progress: document.getElementById('video-progress'),
  progressFill: document.getElementById('video-progress-fill'),
  results: document.getElementById('video-results'),
};

let inputMode = 'text';
let initImageDataUri = null;

function renderPickList() {
  els.list.innerHTML = '';
  Runtime.videoCatalog.forEach(m => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick-card' + (Runtime.videoModel?.id === m.id ? ' is-active' : '');
    card.innerHTML = `
      <div class="pick-card-name">${escapeHtml(m.label)}</div>
      <div class="pick-card-desc">${escapeHtml(m.desc || m.vendor || '')}</div>
      <div class="pick-card-tags">${(m.tags || []).map(t => `<span class="pick-card-tag">${escapeHtml(t)}</span>`).join('')}${m.custom ? '<span class="pick-card-tag">özel</span>' : ''}</div>`;
    card.addEventListener('click', () => selectModel(m));
    els.list.appendChild(card);
  });
}

function selectModel(m) {
  Runtime.videoModel = m;
  if (m.inputMode) setInputMode(m.inputMode);
  renderPickList();
}

function setInputMode(mode) {
  inputMode = mode;
  els.inputModeToggle.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('is-active', b.dataset.value === mode));
  els.textFields.hidden = mode !== 'text';
  els.imageFields.hidden = mode !== 'image';
}

function setInitImage(dataUri) {
  initImageDataUri = dataUri;
  els.imagePreview.hidden = !dataUri;
  els.imagePreview.innerHTML = dataUri ? `<img src="${dataUri}" alt="başlangıç görseli"><button title="Kaldır">✕</button>` : '';
  if (dataUri) els.imagePreview.querySelector('button').addEventListener('click', () => setInitImage(null));
}

function buildPayload() {
  const raw = els.rawJson.value.trim();
  if (raw) {
    try { return JSON.parse(raw); }
    catch (_) { throw new Error('Ham JSON geçersiz — lütfen kontrol et.'); }
  }
  const cfg_scale = parseFloat(els.cfg.value);
  const seed = parseInt(els.seed.value, 10) || 0;

  if (inputMode === 'image') {
    if (!initImageDataUri) throw new Error('Bir başlangıç görseli seç.');
    return { image: initImageDataUri, cfg_scale, seed };
  }
  const prompt = els.prompt.value.trim();
  if (!prompt) throw new Error('Bir istem (prompt) yaz.');
  return { prompt, cfg_scale, seed };
}

function renderResult(video, raw) {
  const card = document.createElement('div');
  card.className = 'result-card';
  if (video?.b64) {
    const dataUri = `data:${video.mime};base64,${video.b64}`;
    card.innerHTML = `
      <video src="${dataUri}" controls loop muted playsinline></video>
      <div class="result-card-meta">
        <span>${Runtime.videoModel?.label || ''}</span>
        <button data-act="dl" title="İndir"><svg class="icon icon-sm"><use href="#i-download"/></svg></button>
      </div>`;
    card.querySelector('[data-act="dl"]').addEventListener('click', () => downloadBase64(video.b64, video.mime, `openllm-${Date.now()}.mp4`));
  } else if (video?.url) {
    card.innerHTML = `
      <video src="${video.url}" controls loop muted playsinline></video>
      <div class="result-card-meta"><span>${Runtime.videoModel?.label || ''}</span><a href="${video.url}" target="_blank" rel="noopener">bağlantı ↗</a></div>`;
  } else {
    card.innerHTML = `<div class="result-card-meta"><span>⚠ beklenmeyen yanıt biçimi</span></div>`;
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:12px;font-size:11px;max-height:240px;overflow:auto;';
    pre.textContent = JSON.stringify(raw, null, 2);
    card.appendChild(pre);
  }
  els.results.prepend(card);
}

async function generate() {
  if (!Runtime.client) { toast('Önce bağlan', 'error'); return; }
  if (!Runtime.videoModel) { toast('Bir video modeli seç', 'error'); return; }

  let payload;
  try { payload = buildPayload(); } catch (err) { toast(err.message, 'error'); return; }

  els.generate.disabled = true;
  els.progress.hidden = false;
  els.progressFill.style.width = '8%';
  els.status.textContent = 'gönderiliyor…';
  els.status.className = 'gate-status';
  setSignalActive(true, 'ember', 'video üretiliyor…');

  let pct = 8;
  try {
    const json = await Runtime.client.invokeGenai({
      invokePath: Runtime.videoModel.invokePath,
      payload,
      onProgress: (phase) => {
        if (phase === 'queued') { els.status.textContent = 'kuyrukta…'; pct = 18; }
        else if (phase === 'processing') { pct = Math.min(pct + 6, 90); els.status.textContent = `işleniyor… (${pct}%)`; }
        else if (phase === 'done') { pct = 100; els.status.textContent = 'tamamlandı'; }
        els.progressFill.style.width = pct + '%';
      }
    });
    const video = extractVideo(json);
    renderResult(video, json);
    els.progressFill.style.width = '100%';
    els.status.textContent = video ? 'video hazır' : 'yanıt alındı (bkz. ham JSON)';
    els.status.classList.add('is-ok');
  } catch (err) {
    const msg = describeError(err);
    els.status.textContent = msg;
    els.status.classList.add('is-error');
    toast(msg, 'error');
  } finally {
    els.generate.disabled = false;
    setSignalActive(false);
    setTimeout(() => { els.progress.hidden = true; els.progressFill.style.width = '0%'; }, 1200);
  }
}

function openAddCustomModal() {
  openModal({
    title: 'Özel video modeli ekle',
    bodyHTML: `
      <label class="field-label">Görünen ad</label>
      <input type="text" id="cm-label" placeholder="Örn: Mochi-1 text2video">
      <label class="field-label">Çağrı yolu (invoke path)</label>
      <input type="text" id="cm-path" placeholder="/v1/genai/genmoai/mochi-1">
      <label class="field-label">Girdi türü</label>
      <select id="cm-inputmode">
        <option value="text">metinden video</option>
        <option value="image">görselden video</option>
      </select>
      <p class="fine-print">build.nvidia.com/explore üzerindeki modelin "invoke_url" değerinden <code>https://ai.api.nvidia.com</code> kısmını çıkararak yapıştır. Gövde şeması modele göre değişir; gerekirse "gelişmiş: ham istek gövdesi" alanını kullan.</p>`,
    actions: [
      { label: 'Vazgeç', onClick: c => c() },
      { label: 'Ekle', variant: 'primary', onClick: (close) => {
        const label = document.getElementById('cm-label').value.trim();
        const path = document.getElementById('cm-path').value.trim();
        const inputModeSel = document.getElementById('cm-inputmode').value;
        if (!label || !path.startsWith('/')) { toast('Ad ve /v1/... ile başlayan bir yol gir', 'error'); return; }
        const entry = { id: `custom:${Date.now()}`, label, vendor: 'özel', desc: path, tags: [], invokePath: path, family: 'generic', inputMode: inputModeSel, custom: true };
        addCustomModel('Video', entry);
        Runtime.videoCatalog = fullVideoCatalog();
        renderPickList();
        selectModel(entry);
        toast('Model eklendi', 'ok');
        close();
      } }
    ]
  });
}

function initDropzone() {
  els.dropzone.addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', async () => {
    const f = els.imageInput.files[0];
    if (f) setInitImage(await fileToBase64(f));
  });
  ['dragover', 'dragleave', 'drop'].forEach(evt => {
    els.dropzone.addEventListener(evt, e => {
      e.preventDefault();
      els.dropzone.classList.toggle('is-drag', evt === 'dragover');
    });
  });
  els.dropzone.addEventListener('drop', async e => {
    const f = e.dataTransfer.files?.[0];
    if (f) setInitImage(await fileToBase64(f));
  });
}

export function initVideo() {
  Runtime.videoCatalog = fullVideoCatalog();
  if (Runtime.videoCatalog.length) Runtime.videoModel = Runtime.videoCatalog[0];
  renderPickList();
  if (Runtime.videoModel?.inputMode) setInputMode(Runtime.videoModel.inputMode);

  els.inputModeToggle.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (btn) setInputMode(btn.dataset.value);
  });
  els.cfg.addEventListener('input', () => els.cfgOut.textContent = els.cfg.value);
  els.seedRandom.addEventListener('click', () => els.seed.value = randomSeed());
  els.generate.addEventListener('click', generate);
  els.addCustom.addEventListener('click', openAddCustomModal);
  initDropzone();

  window.addEventListener('openllm:use-as-video-input', e => {
    setInitImage(e.detail);
    setInputMode('image');
    window.dispatchEvent(new CustomEvent('openllm:switch-mode', { detail: 'video' }));
  });
}
