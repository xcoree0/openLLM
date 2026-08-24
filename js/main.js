// ==========================================================================
// main.js — uygulama girişi: onboarding, model keşfi, kenar çubuğu, mod
// geçişleri ve ayarlar. Diğer tüm modülleri burada birbirine bağlıyoruz.
// ==========================================================================
import { State } from './state.js';
import { Runtime } from './runtime.js';
import { NvidiaClient, NetworkBlockedError, ApiError } from './api.js';
import { categorizeModels } from './catalog.js';
import { toast, openModal, escapeHtml, describeError } from './ui.js';
import { initChat, setModel as setChatModel } from './chat.js';
import { initImage } from './image.js';
import { initVideo } from './video.js';
import { initAgent, setModel as setAgentModel } from './agent.js';

// ==========================================================================
// Ambient background — dağınık düğüm ağı (node-grid). Sinyal izinin
// arka plandaki büyük kardeşi; aynı "dağıtık çıkarım filosu" temasını taşır.
// ==========================================================================
(function bgCanvas() {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let nodes = [];
  let w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(70, Math.max(24, Math.floor((w * h) / 26000)));
    nodes = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18
    }));
  }
  function step() {
    ctx.clearRect(0, 0, w, h);
    for (const n of nodes) {
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 140) {
          ctx.strokeStyle = `rgba(69,224,196,${0.06 * (1 - d / 140)})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    for (const n of nodes) {
      ctx.fillStyle = 'rgba(69,224,196,0.28)';
      ctx.beginPath(); ctx.arc(n.x, n.y, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    if (!reduceMotion) requestAnimationFrame(step);
  }
  window.addEventListener('resize', resize);
  resize();
  step();
})();

// ==========================================================================
// GATE / ONBOARDING
// ==========================================================================
const gateEls = {
  form: document.getElementById('gate-form'),
  key: document.getElementById('gate-key'),
  toggleVis: document.getElementById('gate-toggle-visibility'),
  advanced: document.getElementById('gate-advanced'),
  proxyUrl: document.getElementById('gate-proxy-url'),
  submit: document.getElementById('gate-submit'),
  status: document.getElementById('gate-status'),
  how: document.getElementById('gate-how'),
};

gateEls.toggleVis.addEventListener('click', () => {
  const showing = gateEls.key.type === 'text';
  gateEls.key.type = showing ? 'password' : 'text';
  gateEls.toggleVis.querySelector('use').setAttribute('href', showing ? '#i-eye' : '#i-eye-off');
});

document.querySelectorAll('input[name="connMode"]').forEach(r => {
  r.addEventListener('change', () => { gateEls.proxyUrl.hidden = r.value !== 'proxy' || !r.checked; syncProxyVisibility(); });
});
function syncProxyVisibility() {
  const val = new FormData(gateEls.form).get('connMode');
  gateEls.proxyUrl.hidden = val !== 'proxy';
  if (val === 'proxy') gateEls.advanced.open = true;
}

gateEls.how.addEventListener('click', () => {
  openModal({
    title: 'Bu nasıl çalışır?',
    bodyHTML: `
      <p>OpenLLM tamamen statik bir sayfadır (GitHub Pages'te barınır) — kendi sunucusu yoktur. Girdiğin NVIDIA API anahtarı yalnızca bu tarayıcı sekmesinde (ya da "bu tarayıcıda hatırla" seçtiysen localStorage'da) tutulur ve doğrudan NVIDIA'nın uçlarına gönderilir.</p>
      <p><strong>Neden vekil (proxy) seçeneği var?</strong> NVIDIA'nın API'si tarayıcıdan gelen doğrudan (CORS) isteklere izin vermiyor. Bunu aşmak için kendi ücretsiz Cloudflare Worker'ını (<code>proxy/worker.js</code>) birkaç dakikada devreye alıp buraya adresini yapıştırabilirsin — worker yalnızca isteği NVIDIA'ya iletir, anahtarını saklamaz.</p>
      <p>Detaylı kurulum adımları repodaki <strong>README.md</strong> dosyasında.</p>`,
    actions: [{ label: 'Anladım', variant: 'primary', onClick: c => c() }]
  });
});

gateEls.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(gateEls.form);
  const key = gateEls.key.value.trim();
  const persist = fd.get('remember') === 'local';
  const connMode = fd.get('connMode');
  const proxyUrl = gateEls.proxyUrl.value.trim();

  if (!key) { setGateStatus('Bir API anahtarı gir.', 'error'); return; }
  if (connMode === 'proxy' && !proxyUrl) { setGateStatus('Vekil sunucu adresini gir.', 'error'); return; }

  await attemptConnect({ key, persist, connMode, proxyUrl, silent: false });
});

function setGateStatus(msg, kind) {
  gateEls.status.textContent = msg;
  gateEls.status.className = 'gate-status' + (kind ? ` is-${kind}` : '');
}

async function attemptConnect({ key, persist, connMode, proxyUrl, silent }) {
  gateEls.submit.disabled = true;
  setGateStatus(silent ? 'otomatik bağlanılıyor…' : 'bağlanıyor…');

  const client = new NvidiaClient({ apiKey: key, mode: connMode, proxyUrl });
  try {
    const models = await client.listModels();
    Runtime.client = client;
    Runtime.grouped = categorizeModels(models);
    State.saveApiKey(key, persist);
    State.saveConnection(connMode, proxyUrl);
    setGateStatus(`bağlandı — ${models.length} model bulundu`, 'ok');
    enterApp();
  } catch (err) {
    const msg = describeError(err);
    setGateStatus(msg, 'error');
    if (err instanceof NetworkBlockedError) {
      gateEls.advanced.open = true;
      if (!silent) toast('Doğrudan bağlantı engellendi — vekil (proxy) dene', 'error');
    } else if (!silent) {
      toast(msg, 'error');
    }
  } finally {
    gateEls.submit.disabled = false;
  }
}

// sayfa yüklendiğinde daha önce kaydedilmiş bir anahtar varsa sessizce dene
(function tryResume() {
  const savedKey = State.loadApiKey();
  if (!savedKey) return;
  const conn = State.loadConnection();
  gateEls.key.value = savedKey;
  document.querySelector(`input[name="connMode"][value="${conn.mode}"]`).checked = true;
  gateEls.proxyUrl.value = conn.proxyUrl;
  syncProxyVisibility();
  const persistRadio = document.querySelector('input[name="remember"][value="local"]');
  if (localStorage.getItem('openllm.apiKey')) persistRadio.checked = true;
  attemptConnect({ key: savedKey, persist: persistRadio.checked, connMode: conn.mode, proxyUrl: conn.proxyUrl, silent: true });
})();

// ==========================================================================
// APP SHELL — sidebar, mode switching, settings
// ==========================================================================
const appEls = {
  gateView: document.getElementById('view-gate'),
  appView: document.getElementById('view-app'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  sidebarLoading: document.getElementById('sidebar-loading'),
  modelGroups: document.getElementById('model-groups'),
  modelSearch: document.getElementById('model-search'),
  modelRefresh: document.getElementById('model-refresh'),
  keyPillLabel: document.getElementById('key-pill-label'),
  changeKeyBtn: document.getElementById('btn-change-key'),
  modeTabs: document.querySelectorAll('.mode-tab'),
  modePanels: document.querySelectorAll('.mode-panel'),
  settingsBtn: document.getElementById('btn-settings'),
  chatModelChip: document.getElementById('chat-model-chip'),
  agentModelChip: document.getElementById('agent-model-chip'),
};

let sidebarInited = false;
const collapsedGroups = new Set(['embed', 'rerank', 'guard']);
let searchQuery = '';

const GROUP_META = {
  chat: { label: 'Metin ve Görü', dot: 'dot-chat' },
  embed: { label: 'Gömme (Embedding)', dot: 'dot-embed' },
  rerank: { label: 'Yeniden Sıralama', dot: 'dot-rerank' },
  guard: { label: 'Güvenlik / Guard', dot: 'dot-guard' },
};

function enterApp() {
  appEls.gateView.hidden = true;
  appEls.appView.hidden = false;
  appEls.keyPillLabel.textContent = maskKey(Runtime.client.apiKey);

  if (!sidebarInited) {
    initChat();
    initImage();
    initVideo();
    initAgent();
    wireAppShell();
    sidebarInited = true;
  }

  renderSidebar();
  const firstChat = Runtime.grouped.chat[0];
  if (firstChat) {
    setChatModel(firstChat.id);
    setAgentModel(firstChat.id);
  }
}

function maskKey(key) {
  if (!key) return '';
  return key.slice(0, 9) + '…' + key.slice(-4);
}

function wireAppShell() {
  appEls.modeTabs.forEach(tab => tab.addEventListener('click', () => switchMode(tab.dataset.mode)));
  window.addEventListener('openllm:switch-mode', e => switchMode(e.detail));

  appEls.modelSearch.addEventListener('input', () => { searchQuery = appEls.modelSearch.value.toLowerCase(); renderSidebar(); });
  appEls.modelRefresh.addEventListener('click', refreshModels);
  appEls.changeKeyBtn.addEventListener('click', () => {
    State.clearApiKey();
    location.reload();
  });
  appEls.settingsBtn.addEventListener('click', openSettingsModal);

  appEls.chatModelChip.addEventListener('click', () => {
    pickModelModal(visibleChatModels(), id => setChatModel(id), 'Metin modeli seç');
  });
  appEls.agentModelChip.addEventListener('click', () => {
    pickModelModal(visibleChatModels(), id => setAgentModel(id), 'Ajan modeli seç (araç çağırma destekli)');
  });

  // mobil kenar çubuğu
  const toggleBtn = document.getElementById('btn-sidebar-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => setSidebarOpen(!appEls.sidebar.classList.contains('is-open')));
    appEls.sidebarScrim.addEventListener('click', () => setSidebarOpen(false));
  }
}

function visibleChatModels() { return Runtime.grouped.chat; }

function setSidebarOpen(open) {
  appEls.sidebar.classList.toggle('is-open', open);
  appEls.sidebarScrim.hidden = !open;
}

function switchMode(mode) {
  appEls.modeTabs.forEach(t => {
    const active = t.dataset.mode === mode;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', String(active));
  });
  appEls.modePanels.forEach(p => {
    const active = p.dataset.panel === mode;
    p.classList.toggle('is-active', active);
    p.hidden = !active;
  });
  setSidebarOpen(false);
}

async function refreshModels() {
  if (!Runtime.client) return;
  try {
    const models = await Runtime.client.listModels();
    Runtime.grouped = categorizeModels(models);
    renderSidebar();
    toast('Model listesi yenilendi', 'ok', 2200);
  } catch (err) {
    toast(describeError(err), 'error');
  }
}

// -------------------------------------------------------------- sidebar --
function renderSidebar() {
  appEls.sidebarLoading.hidden = true;
  appEls.modelGroups.innerHTML = '';

  for (const key of ['chat', 'embed', 'rerank', 'guard']) {
    const all = Runtime.grouped[key] || [];
    const list = searchQuery ? all.filter(m => m.id.toLowerCase().includes(searchQuery)) : all;
    if (list.length === 0) continue;

    const meta = GROUP_META[key];
    const group = document.createElement('div');
    group.className = 'model-group' + (collapsedGroups.has(key) && !searchQuery ? ' is-collapsed' : '');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'model-group-head';
    head.innerHTML = `<svg class="icon"><use href="#i-chevron"/></svg><span>${meta.label}</span><span class="model-group-count">${list.length}</span>`;
    head.addEventListener('click', () => {
      group.classList.toggle('is-collapsed');
      if (group.classList.contains('is-collapsed')) collapsedGroups.add(key); else collapsedGroups.delete(key);
    });

    const body = document.createElement('div');
    body.className = 'model-group-body';
    for (const m of list) body.appendChild(buildModelCard(m, key));

    group.appendChild(head);
    group.appendChild(body);
    appEls.modelGroups.appendChild(group);
  }

  if (appEls.modelGroups.children.length === 0) {
    appEls.modelGroups.innerHTML = `<div class="sidebar-loading"><span>Eşleşen model yok.</span></div>`;
  }
}

function buildModelCard(m, groupKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  const isActive = (groupKey === 'chat' && m.id === Runtime.chatModel);
  btn.className = 'model-card' + (isActive ? ' is-active' : '');
  const dotClass = groupKey === 'chat' ? (m.isVision ? 'dot-vision' : 'dot-chat') : GROUP_META[groupKey].dot;
  const badge = m.isVision ? '<span class="model-card-badge">görü</span>' : (m.isCode ? '<span class="model-card-badge">kod</span>' : '');
  btn.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <span class="model-card-body">
      <span class="model-card-name">${escapeHtml(m.id)}</span>
      <span class="model-card-meta">${escapeHtml(m.owned_by || '')}</span>
    </span>
    ${badge}`;
  btn.addEventListener('click', () => {
    if (groupKey === 'chat') { setChatModel(m.id); switchMode('chat'); renderSidebar(); }
    else if (groupKey === 'embed') openEmbedInspector(m);
    else if (groupKey === 'rerank') openRerankInspector(m);
    else if (groupKey === 'guard') openGuardInspector(m);
  });
  return btn;
}

// -------------------------------------------------------- model picker ---
function pickModelModal(models, onPick, title) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'max-height:52vh;overflow-y:auto;display:flex;flex-direction:column;gap:3px;';
  if (models.length === 0) wrap.innerHTML = '<p class="fine-print">Uygun model bulunamadı.</p>';
  for (const m of models) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick-card';
    b.style.textAlign = 'left';
    b.innerHTML = `<div class="pick-card-name">${escapeHtml(m.id)}</div>${m.isVision ? '<div class="pick-card-tags"><span class="pick-card-tag">görü</span></div>' : ''}`;
    wrap.appendChild(b);
    b.addEventListener('click', () => { onPick(m.id); modal.close(); });
  }
  const modal = openModal({ title, bodyNode: wrap, actions: [{ label: 'Kapat', onClick: c => c() }] });
}

// --------------------------------------------------- utility inspectors --
function openEmbedInspector(model) {
  const { root } = openModal({
    title: `Gömme testi — ${model.id}`,
    bodyHTML: `
      <label class="field-label">Metin</label>
      <textarea id="insp-text" rows="3" style="width:100%;background:var(--ink-2);border:1px solid var(--hairline);border-radius:8px;padding:9px;color:var(--text-hi);font-size:13px;" placeholder="Gömme vektörüne çevrilecek metin"></textarea>
      <div id="insp-result" class="fine-print"></div>`,
    actions: [
      { label: 'Kapat', onClick: c => c() },
      { label: 'Vektörü al', variant: 'primary', onClick: async () => {
        const text = root.querySelector('#insp-text').value.trim();
        const out = root.querySelector('#insp-result');
        if (!text) return;
        out.textContent = 'hesaplanıyor…';
        try {
          const res = await Runtime.client.createEmbeddings({ model: model.id, input: text });
          const vec = res?.data?.[0]?.embedding || [];
          out.innerHTML = `boyut: <strong>${vec.length}</strong><br>ilk 8 değer: <code>${vec.slice(0, 8).map(n => Number(n).toFixed(4)).join(', ')}</code>`;
        } catch (err) { out.textContent = describeError(err); }
      } }
    ]
  });
}

function openRerankInspector(model) {
  const { root } = openModal({
    title: `Yeniden sıralama testi — ${model.id}`,
    bodyHTML: `
      <p class="fine-print">Deneysel: NVIDIA'nın yeniden sıralama uçları arasında gövde şeması değişebilir.</p>
      <label class="field-label">Sorgu</label>
      <input type="text" id="insp-query" placeholder="Örn: en iyi kahve makinesi">
      <label class="field-label">Belgeler <span class="muted">(her satıra bir tane)</span></label>
      <textarea id="insp-docs" rows="4" style="width:100%;background:var(--ink-2);border:1px solid var(--hairline);border-radius:8px;padding:9px;color:var(--text-hi);font-size:13px;" placeholder="Belge 1&#10;Belge 2&#10;Belge 3"></textarea>
      <div id="insp-result" class="fine-print"></div>`,
    actions: [
      { label: 'Kapat', onClick: c => c() },
      { label: 'Sırala', variant: 'primary', onClick: async () => {
        const query = root.querySelector('#insp-query').value.trim();
        const docs = root.querySelector('#insp-docs').value.split('\n').map(s => s.trim()).filter(Boolean);
        const out = root.querySelector('#insp-result');
        if (!query || docs.length === 0) return;
        out.textContent = 'sıralanıyor…';
        try {
          const res = await Runtime.client.rerank({ model: model.id, query, passages: docs });
          out.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(JSON.stringify(res, null, 2))}</pre>`;
        } catch (err) { out.textContent = describeError(err); }
      } }
    ]
  });
}

function openGuardInspector(model) {
  const { root } = openModal({
    title: `Güvenlik testi — ${model.id}`,
    bodyHTML: `
      <p class="fine-print">Deneysel: model, sınıflandırma sonucunu sohbet yanıtı olarak döndürür.</p>
      <label class="field-label">Denetlenecek metin</label>
      <textarea id="insp-text" rows="3" style="width:100%;background:var(--ink-2);border:1px solid var(--hairline);border-radius:8px;padding:9px;color:var(--text-hi);font-size:13px;"></textarea>
      <div id="insp-result" class="fine-print"></div>`,
    actions: [
      { label: 'Kapat', onClick: c => c() },
      { label: 'Denetle', variant: 'primary', onClick: async () => {
        const text = root.querySelector('#insp-text').value.trim();
        const out = root.querySelector('#insp-result');
        if (!text) return;
        out.textContent = 'denetleniyor…';
        try {
          const res = await Runtime.client.chatCompletion({ model: model.id, messages: [{ role: 'user', content: text }], max_tokens: 200 });
          out.innerHTML = `<pre style="white-space:pre-wrap;font-size:11px;">${escapeHtml(res?.choices?.[0]?.message?.content || JSON.stringify(res))}</pre>`;
        } catch (err) { out.textContent = describeError(err); }
      } }
    ]
  });
}

// -------------------------------------------------------------- settings --
function openSettingsModal() {
  const conn = State.loadConnection();
  const { root } = openModal({
    title: 'Ayarlar',
    bodyHTML: `
      <label class="field-label">Bağlantı yöntemi</label>
      <div class="conn-mode">
        <label class="chip-toggle"><input type="radio" name="s-connMode" value="direct" ${conn.mode === 'direct' ? 'checked' : ''}><span>Doğrudan bağlan</span></label>
        <label class="chip-toggle"><input type="radio" name="s-connMode" value="proxy" ${conn.mode === 'proxy' ? 'checked' : ''}><span>Kendi vekil sunucum</span></label>
      </div>
      <input type="url" id="s-proxy-url" placeholder="https://senin-worker-adresin.workers.dev" value="${escapeHtml(conn.proxyUrl)}" ${conn.mode === 'proxy' ? '' : 'hidden'}>
      <hr class="modal-divider">
      <p class="fine-print">Anahtarın ve tüm sohbet/model verilerin yalnızca bu tarayıcıda tutulur. Aşağıdaki buton her şeyi kalıcı olarak siler.</p>
      <button id="s-wipe" class="btn-secondary btn-block" style="color:var(--danger);border-color:rgba(255,107,107,.35);">Anahtarı ve tüm verileri unut</button>`,
    actions: [
      { label: 'Kapat', onClick: c => c() },
      { label: 'Kaydet', variant: 'primary', onClick: (close) => {
        const mode = root.querySelector('input[name="s-connMode"]:checked').value;
        const proxyUrl = root.querySelector('#s-proxy-url').value.trim();
        State.saveConnection(mode, proxyUrl);
        Runtime.client?.update({ mode, proxyUrl });
        toast('Ayarlar kaydedildi', 'ok');
        close();
      } }
    ]
  });
  root.querySelectorAll('input[name="s-connMode"]').forEach(r => {
    r.addEventListener('change', () => { root.querySelector('#s-proxy-url').hidden = r.value !== 'proxy'; });
  });
  root.querySelector('#s-wipe').addEventListener('click', () => {
    State.wipeAll();
    location.reload();
  });
}
