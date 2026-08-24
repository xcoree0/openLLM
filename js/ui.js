// ==========================================================================
// ui.js — paylaşılan arayüz yardımcıları (toast, modal, markdown, sinyal izi)
// ==========================================================================

import { NetworkBlockedError, ApiError } from './api.js';

const toastRoot = document.getElementById('toast-root');
const modalRoot = document.getElementById('modal-root');

export function describeError(err) {
  if (err instanceof NetworkBlockedError) return err.message;
  if (err instanceof ApiError) return `API hatası (${err.status}): ${err.message}`;
  if (err?.name === 'AbortError') return 'Durduruldu.';
  return err?.message || 'Bilinmeyen bir hata oluştu.';
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function toast(message, type = 'ok', ttl = 4200) {
  const el = document.createElement('div');
  el.className = `toast is-${type}`;
  const iconId = type === 'error' ? 'i-warn' : 'i-check';
  el.innerHTML = `<svg class="icon icon-sm"><use href="#${iconId}"/></svg><span>${escapeHtml(message)}</span>`;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, ttl);
}

/**
 * @param {{title:string, bodyHTML?:string, bodyNode?:Node, actions?:{label:string, variant?:string, onClick:(close:Function)=>void}[]}} opts
 */
export function openModal({ title, bodyHTML = '', bodyNode = null, actions = [] }) {
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  scrim.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="icon-btn icon-btn-ghost" data-close><svg class="icon"><use href="#i-x"/></svg></button>
      </div>
      <div class="modal-body" id="modal-body-slot"></div>
      <div class="modal-actions" id="modal-actions-slot"></div>
    </div>`;
  document.body.appendChild(scrim);
  modalRoot.appendChild(scrim);

  const bodySlot = scrim.querySelector('#modal-body-slot');
  if (bodyNode) bodySlot.appendChild(bodyNode); else bodySlot.innerHTML = bodyHTML;

  const close = () => scrim.remove();
  scrim.querySelector('[data-close]').addEventListener('click', close);
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  const escHandler = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);

  const actionsSlot = scrim.querySelector('#modal-actions-slot');
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.className = a.variant === 'primary' ? 'btn-primary' : (a.variant === 'ghost' ? 'btn-ghost' : 'btn-secondary');
    btn.textContent = a.label;
    btn.addEventListener('click', () => a.onClick(close));
    actionsSlot.appendChild(btn);
  });

  return { close, root: scrim };
}

// --------------------------------------------------------------------------
// Minimal, güvenli markdown -> HTML. Önce HTML kaçışı yapılır, sonra sınırlı
// bir söz dizimi uygulanır (kalın, italik, satır-içi kod, kod bloğu, bağlantı,
// liste). Hiçbir zaman ham HTML enjekte edilmez.
// --------------------------------------------------------------------------
export function renderMarkdown(raw) {
  const escaped = escapeHtml(raw);
  const codeBlocks = [];
  let text = escaped.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });

  text = text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = text.split('\n');
  const out = [];
  let listBuf = null;
  const flushList = () => { if (listBuf) { out.push(`<${listBuf.type}>${listBuf.items.join('')}</${listBuf.type}>`); listBuf = null; } };

  for (const line of lines) {
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ol) {
      if (!listBuf || listBuf.type !== 'ol') { flushList(); listBuf = { type: 'ol', items: [] }; }
      listBuf.items.push(`<li>${ol[1]}</li>`);
    } else if (ul) {
      if (!listBuf || listBuf.type !== 'ul') { flushList(); listBuf = { type: 'ul', items: [] }; }
      listBuf.items.push(`<li>${ul[1]}</li>`);
    } else {
      flushList();
      if (line.trim() === '') out.push('');
      else out.push(`<p>${line}</p>`);
    }
  }
  flushList();

  let html = out.join('\n');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);
  return html;
}

// --------------------------------------------------------------------------
// Sinyal izi — üstteki durum çubuğunda akan osiloskop çizgisi. Tüm istek
// döngülerinde (chat streaming, görsel/video üretimi, ajan adımları) tek bir
// görsel motif olarak yeniden kullanılır.
// --------------------------------------------------------------------------
const traceEl = document.getElementById('signal-trace-line');
const traceSvg = document.getElementById('signal-trace');
const statusEl = document.getElementById('topbar-status');
let traceRAF = null;
let traceActive = false;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function drawFlat() {
  if (!traceEl) return;
  traceEl.setAttribute('points', '0,14 160,14');
}

function drawWave(t) {
  if (!traceEl) return;
  const pts = [];
  for (let x = 0; x <= 160; x += 8) {
    const n = Math.sin(x * 0.09 + t) * 5 + Math.sin(x * 0.23 - t * 1.7) * 3;
    pts.push(`${x},${14 + n}`);
  }
  traceEl.setAttribute('points', pts.join(' '));
}

function loop(ts) {
  if (!traceActive) return;
  drawWave(ts / 220);
  traceRAF = requestAnimationFrame(loop);
}

export function setSignalActive(active, tone = 'signal', label) {
  traceActive = active;
  if (!traceSvg) return;
  traceSvg.classList.toggle('is-active', active);
  traceSvg.classList.remove('tone-ember', 'tone-violet');
  if (tone === 'ember') traceSvg.classList.add('tone-ember');
  if (tone === 'violet') traceSvg.classList.add('tone-violet');

  if (statusEl) statusEl.textContent = label || (active ? 'çalışıyor…' : 'hazır');

  if (active && !reduceMotion) {
    if (!traceRAF) traceRAF = requestAnimationFrame(loop);
  } else {
    if (traceRAF) cancelAnimationFrame(traceRAF);
    traceRAF = null;
    drawFlat();
  }
}
drawFlat();

// --------------------------------------------------------------------------
// Dosya yardımcıları
// --------------------------------------------------------------------------
export function downloadBase64(b64, mime, filename) {
  const a = document.createElement('a');
  a.href = `data:${mime};base64,${b64}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Panoya kopyalandı', 'ok', 1800);
  } catch (_) {
    toast('Kopyalanamadı', 'error');
  }
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // data: URI olarak döner
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function randomSeed() {
  return Math.floor(Math.random() * 2_147_483_647);
}
