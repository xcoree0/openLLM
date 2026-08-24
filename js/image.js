// ==========================================================================
// image.js — görsel üretim stüdyosu
// ==========================================================================
import { Runtime } from './runtime.js';
import { fullImageCatalog, addCustomModel } from './catalog.js';
import { toast, openModal, setSignalActive, downloadBase64, randomSeed, escapeHtml, describeError } from './ui.js';
import { extractImages } from './api.js';


const els = {
  list: document.getElementById('image-model-list'),
  addCustom: document.getElementById('image-add-custom'),
  prompt: document.getElementById('image-prompt'),
  negative: document.getElementById('image-negative'),
  steps: document.getElementById('image-steps'),
  stepsOut: document.getElementById('image-steps-out'),
  cfg: document.getElementById('image-cfg'),
  cfgOut: document.getElementById('image-cfg-out'),
  seed: document.getElementById('image-seed'),
  seedRandom: document.getElementById('image-seed-random'),
  size: document.getElementById('image-size'),
  rawJson: document.getElementById('image-raw-json'),
  generate: document.getElementById('image-generate'),
  status: document.getElementById('image-status'),
  results: document.getElementById('image-results'),
};

function renderPickList() {
  els.list.innerHTML = '';
  Runtime.imageCatalog.forEach((m, i) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'pick-card' + (Runtime.imageModel?.id === m.id ? ' is-active' : '');
    card.innerHTML = `
      <div class="pick-card-name">${escapeHtml(m.label)}</div>
      <div class="pick-card-desc">${escapeHtml(m.desc || m.vendor || '')}</div>
      <div class="pick-card-tags">${(m.tags || []).map(t => `<span class="pick-card-tag">${escapeHtml(t)}</span>`).join('')}${m.custom ? '<span class="pick-card-tag">özel</span>' : ''}</div>`;
    card.addEventListener('click', () => selectModel(m));
    els.list.appendChild(card);
  });
}

function selectModel(m) {
  Runtime.imageModel = m;
  if (m.defaultSteps) { els.steps.value = m.defaultSteps; els.stepsOut.textContent = m.defaultSteps; }
  renderPickList();
}

function buildPayload() {
  const raw = els.rawJson.value.trim();
  if (raw) {
    try { return JSON.parse(raw); }
    catch (_) { throw new Error('Ham JSON geçersiz — lütfen kontrol et.'); }
  }
  const [w, h] = els.size.value.split('x').map(Number);
  const prompt = els.prompt.value.trim();
  const negative = els.negative.value.trim();
  const family = Runtime.imageModel?.family;

  if (family === 'stability-artifacts') {
    const text_prompts = [{ text: prompt, weight: 1 }];
    if (negative) text_prompts.push({ text: negative, weight: -1 });
    return {
      text_prompts,
      cfg_scale: parseFloat(els.cfg.value),
      steps: parseInt(els.steps.value, 10),
      seed: parseInt(els.seed.value, 10) || 0,
      sampler: 'K_EULER_ANCESTRAL',
      width: w, height: h
    };
  }
  // bilinmeyen / özel model — en yaygın "genel" şema
  const payload = {
    prompt,
    steps: parseInt(els.steps.value, 10),
    cfg_scale: parseFloat(els.cfg.value),
    seed: parseInt(els.seed.value, 10) || 0,
    width: w, height: h
  };
  if (negative) payload.negative_prompt = negative;
  return payload;
}

function renderResult(images, raw) {
  if (images.length === 0) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `<div class="result-card-meta"><span>⚠ beklenmeyen yanıt biçimi</span></div>`;
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:12px;font-size:11px;max-height:240px;overflow:auto;';
    pre.textContent = JSON.stringify(raw, null, 2);
    card.appendChild(pre);
    els.results.prepend(card);
    return;
  }
  for (const img of images) {
    const dataUri = `data:${img.mime};base64,${img.b64}`;
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <img src="${dataUri}" alt="üretilen görsel">
      <div class="result-card-meta">
        <span>${img.seed !== undefined ? 'seed ' + img.seed : Runtime.imageModel?.label || ''}</span>
        <span style="display:flex;gap:6px;">
          <button data-act="video" title="Videoya gönder"><svg class="icon icon-sm"><use href="#i-video"/></svg></button>
          <button data-act="dl" title="İndir"><svg class="icon icon-sm"><use href="#i-download"/></svg></button>
        </span>
      </div>`;
    card.querySelector('[data-act="dl"]').addEventListener('click', () => downloadBase64(img.b64, img.mime, `openllm-${Date.now()}.png`));
    card.querySelector('[data-act="video"]').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('openllm:use-as-video-input', { detail: dataUri }));
      toast('Görsel Video sekmesine gönderildi', 'ok');
    });
    els.results.prepend(card);
  }
}

async function generate() {
  if (!Runtime.client) { toast('Önce bağlan', 'error'); return; }
  if (!Runtime.imageModel) { toast('Bir görsel modeli seç', 'error'); return; }
  if (!els.prompt.value.trim() && !els.rawJson.value.trim()) { toast('Bir istem (prompt) yaz', 'error'); return; }

  let payload;
  try { payload = buildPayload(); } catch (err) { toast(err.message, 'error'); return; }

  els.generate.disabled = true;
  els.status.textContent = 'gönderiliyor…';
  els.status.className = 'gate-status';
  setSignalActive(true, 'ember', 'görsel üretiliyor…');

  try {
    const json = await Runtime.client.invokeGenai({
      invokePath: Runtime.imageModel.invokePath,
      payload,
      onProgress: (phase) => { els.status.textContent = phase === 'queued' ? 'kuyrukta…' : phase === 'processing' ? 'işleniyor…' : 'tamamlandı'; }
    });
    const images = extractImages(json);
    renderResult(images, json);
    els.status.textContent = images.length ? `${images.length} görsel üretildi` : 'yanıt alındı (bkz. ham JSON)';
    els.status.classList.add('is-ok');
  } catch (err) {
    const msg = describeError(err);
    els.status.textContent = msg;
    els.status.classList.add('is-error');
    toast(msg, 'error');
  } finally {
    els.generate.disabled = false;
    setSignalActive(false);
  }
}

function openAddCustomModal() {
  openModal({
    title: 'Özel görsel modeli ekle',
    bodyHTML: `
      <label class="field-label">Görünen ad</label>
      <input type="text" id="cm-label" placeholder="Örn: FLUX.1 schnell">
      <label class="field-label">Çağrı yolu (invoke path)</label>
      <input type="text" id="cm-path" placeholder="/v1/genai/black-forest-labs/flux.1-schnell">
      <label class="field-label">Gövde şeması</label>
      <select id="cm-family">
        <option value="stability-artifacts">stability-tarzı (text_prompts[])</option>
        <option value="generic">genel (prompt / cfg_scale / steps)</option>
      </select>
      <p class="fine-print">build.nvidia.com/explore üzerindeki modelin "invoke_url" değerinden <code>https://ai.api.nvidia.com</code> kısmını çıkararak yapıştır.</p>`,
    actions: [
      { label: 'Vazgeç', onClick: c => c() },
      { label: 'Ekle', variant: 'primary', onClick: (close) => {
        const label = document.getElementById('cm-label').value.trim();
        const path = document.getElementById('cm-path').value.trim();
        const family = document.getElementById('cm-family').value;
        if (!label || !path.startsWith('/')) { toast('Ad ve /v1/... ile başlayan bir yol gir', 'error'); return; }
        const entry = { id: `custom:${Date.now()}`, label, vendor: 'özel', desc: path, tags: [], invokePath: path, family, custom: true };
        addCustomModel('Image', entry);
        Runtime.imageCatalog = fullImageCatalog();
        renderPickList();
        selectModel(entry);
        toast('Model eklendi', 'ok');
        close();
      } }
    ]
  });
}

export function initImage() {
  Runtime.imageCatalog = fullImageCatalog();
  if (Runtime.imageCatalog.length) Runtime.imageModel = Runtime.imageCatalog[0];
  renderPickList();

  els.steps.addEventListener('input', () => els.stepsOut.textContent = els.steps.value);
  els.cfg.addEventListener('input', () => els.cfgOut.textContent = els.cfg.value);
  els.seedRandom.addEventListener('click', () => els.seed.value = randomSeed());
  els.generate.addEventListener('click', generate);
  els.addCustom.addEventListener('click', openAddCustomModal);
}
