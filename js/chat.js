// ==========================================================================
// chat.js — sohbet paneli: thread listesi, streaming yanıtlar, görsel ekler
// ==========================================================================
import { State, uid } from './state.js';
import { Runtime } from './runtime.js';
import { toast, renderMarkdown, setSignalActive, fileToBase64, describeError } from './ui.js';

const els = {
  messages: document.getElementById('chat-messages'),
  empty: document.getElementById('chat-empty'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('chat-send'),
  threadList: document.getElementById('thread-list'),
  newThreadBtn: document.getElementById('btn-new-thread'),
  modelChip: document.getElementById('chat-model-chip'),
  modelLabel: document.getElementById('chat-model-label'),
  paramsBtn: document.getElementById('chat-params-btn'),
  paramsPop: document.getElementById('chat-params-pop'),
  systemInput: document.getElementById('chat-system'),
  temp: document.getElementById('chat-temp'),
  tempOut: document.getElementById('chat-temp-out'),
  maxtok: document.getElementById('chat-maxtok'),
  maxtokOut: document.getElementById('chat-maxtok-out'),
  attachBtn: document.getElementById('chat-attach-btn'),
  fileInput: document.getElementById('chat-file-input'),
  attachments: document.getElementById('chat-attachments'),
};

let threads = State.getJSON('chatThreads', []);
let activeThreadId = threads[0]?.id || null;
let pendingImages = []; // [{dataUri, name}]
let abortCtrl = null;
let isStreaming = false;

function saveThreads() { State.setJSON('chatThreads', threads); }

function activeThread() { return threads.find(t => t.id === activeThreadId) || null; }

export function setModel(modelId) {
  Runtime.chatModel = modelId;
  els.modelLabel.textContent = modelId;
  const t = activeThread();
  if (t && !t.model) { t.model = modelId; saveThreads(); }
  updateAttachAvailability();
}

function updateAttachAvailability() {
  const model = [...Runtime.grouped.chat].find(m => m.id === Runtime.chatModel);
  const canVision = !!model?.isVision;
  els.attachBtn.hidden = !canVision;
  if (!canVision) clearAttachments();
}

export function newThread(select = true) {
  const t = { id: uid(), title: 'Yeni sohbet', model: Runtime.chatModel, messages: [], createdAt: Date.now() };
  threads.unshift(t);
  saveThreads();
  activeThreadId = t.id;
  if (select) { renderThreadList(); renderMessages(); } else { renderThreadList(); }
  return t;
}

export function selectThread(id) {
  activeThreadId = id;
  const t = activeThread();
  if (t?.model) setModel(t.model);
  renderThreadList();
  renderMessages();
}

function deleteThread(id) {
  threads = threads.filter(t => t.id !== id);
  saveThreads();
  if (activeThreadId === id) activeThreadId = threads[0]?.id || null;
  renderThreadList();
  renderMessages();
}

function renderThreadList() {
  els.threadList.innerHTML = '';
  for (const t of threads) {
    const item = document.createElement('div');
    item.className = 'thread-item' + (t.id === activeThreadId ? ' is-active' : '');
    item.innerHTML = `<span class="thread-item-title"></span><button class="thread-item-del" title="Sil" aria-label="Sohbeti sil"><svg class="icon icon-sm"><use href="#i-trash"/></svg></button>`;
    item.querySelector('.thread-item-title').textContent = t.title || 'Yeni sohbet';
    item.addEventListener('click', e => { if (!e.target.closest('.thread-item-del')) selectThread(t.id); });
    item.querySelector('.thread-item-del').addEventListener('click', e => { e.stopPropagation(); deleteThread(t.id); });
    els.threadList.appendChild(item);
  }
}

function renderMessages() {
  const t = activeThread();
  els.messages.innerHTML = '';
  if (!t || t.messages.length === 0) {
    els.empty.hidden = false;
    els.messages.appendChild(els.empty);
    return;
  }
  els.empty.hidden = true;
  for (const m of t.messages) els.messages.appendChild(renderMessageEl(m));
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderMessageEl(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg-${m.role}`;
  const avatar = m.role === 'user' ? 'sen' : 'ai';
  const roleLabel = m.role === 'user' ? 'sen' : (Runtime.chatModel || 'asistan');
  const imagesHtml = m.images?.length
    ? `<div class="msg-images">${m.images.map(src => `<img src="${src}" alt="ek görsel">`).join('')}</div>`
    : '';
  wrap.innerHTML = `
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-body">
      <div class="msg-role">${roleLabel}</div>
      ${imagesHtml}
      <div class="msg-text">${m.error ? `<span class="msg-error">${m.content}</span>` : renderMarkdown(m.content || '')}</div>
    </div>`;
  return wrap;
}

function appendStreamingBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  wrap.innerHTML = `
    <div class="msg-avatar">ai</div>
    <div class="msg-body">
      <div class="msg-role">${Runtime.chatModel || 'asistan'}</div>
      <div class="msg-text"><span class="msg-cursor"></span></div>
    </div>`;
  els.empty.hidden = true;
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap.querySelector('.msg-text');
}

function clearAttachments() {
  pendingImages = [];
  els.attachments.innerHTML = '';
  els.attachments.hidden = true;
  els.fileInput.value = '';
}

function renderAttachments() {
  els.attachments.innerHTML = '';
  els.attachments.hidden = pendingImages.length === 0;
  pendingImages.forEach((img, i) => {
    const t = document.createElement('div');
    t.className = 'attach-thumb';
    t.innerHTML = `<img src="${img.dataUri}" alt="${img.name}"><button title="Kaldır" aria-label="Kaldır">✕</button>`;
    t.querySelector('button').addEventListener('click', () => { pendingImages.splice(i, 1); renderAttachments(); });
    els.attachments.appendChild(t);
  });
}

function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}

function setSending(sending) {
  isStreaming = sending;
  els.send.querySelector('use').setAttribute('href', sending ? '#i-stop' : '#i-send');
  els.send.title = sending ? 'Durdur' : 'Gönder';
}

async function handleSend(e) {
  e.preventDefault();
  if (isStreaming) { abortCtrl?.abort(); return; }

  const text = els.input.value.trim();
  if (!text && pendingImages.length === 0) return;
  if (!Runtime.chatModel) { toast('Önce soldan bir metin modeli seç', 'error'); return; }
  if (!Runtime.client) { toast('Önce bağlan', 'error'); return; }

  let t = activeThread();
  if (!t) t = newThread();
  if (t.messages.length === 0) t.title = text.slice(0, 48) || 'Görsel mesaj';

  const userMsg = { role: 'user', content: text, images: pendingImages.map(p => p.dataUri) };
  t.messages.push(userMsg);
  els.messages.appendChild(renderMessageEl(userMsg));
  els.empty.hidden = true;
  els.messages.scrollTop = els.messages.scrollHeight;

  const apiMessages = buildApiMessages(t);
  els.input.value = '';
  autoGrow();
  const imagesForThisTurn = [...pendingImages];
  clearAttachments();

  const bubble = appendStreamingBubble();
  setSending(true);
  setSignalActive(true, 'signal', 'yanıt akıyor…');
  abortCtrl = new AbortController();

  try {
    const full = await Runtime.client.chatCompletionStream({
      model: Runtime.chatModel,
      messages: apiMessages,
      temperature: parseFloat(els.temp.value),
      max_tokens: parseInt(els.maxtok.value, 10),
      signal: abortCtrl.signal,
      onDelta: (_, fullSoFar) => {
        bubble.innerHTML = renderMarkdown(fullSoFar) + '<span class="msg-cursor"></span>';
        els.messages.scrollTop = els.messages.scrollHeight;
      }
    });
    bubble.innerHTML = renderMarkdown(full || '_(boş yanıt)_');
    t.messages.push({ role: 'assistant', content: full });
    saveThreads();
    renderThreadList();
  } catch (err) {
    const msg = describeError(err);
    bubble.innerHTML = `<span class="msg-error">${msg}</span>`;
    t.messages.push({ role: 'assistant', content: msg, error: true });
    saveThreads();
    if (!(err.name === 'AbortError')) toast(msg, 'error');
  } finally {
    setSending(false);
    setSignalActive(false);
    abortCtrl = null;
  }
}

function buildApiMessages(t) {
  const out = [];
  const sys = els.systemInput.value.trim();
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of t.messages) {
    if (m.error) continue;
    if (m.images?.length) {
      const parts = [{ type: 'text', text: m.content || ' ' }];
      for (const src of m.images) parts.push({ type: 'image_url', image_url: { url: src } });
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function initAttachments() {
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    for (const file of els.fileInput.files) {
      const dataUri = await fileToBase64(file);
      pendingImages.push({ dataUri, name: file.name });
    }
    renderAttachments();
  });
}

export function initChat() {
  if (threads.length === 0) newThread(false);
  renderThreadList();
  renderMessages();
  initAttachments();

  els.newThreadBtn.addEventListener('click', () => newThread());
  els.form.addEventListener('submit', handleSend);
  els.input.addEventListener('input', autoGrow);
  els.input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
  });

  els.paramsBtn.addEventListener('click', () => { els.paramsPop.hidden = !els.paramsPop.hidden; });
  document.addEventListener('click', e => {
    if (!els.paramsPop.hidden && !els.paramsPop.contains(e.target) && e.target !== els.paramsBtn && !els.paramsBtn.contains(e.target)) {
      els.paramsPop.hidden = true;
    }
  });
  els.temp.addEventListener('input', () => els.tempOut.textContent = els.temp.value);
  els.maxtok.addEventListener('input', () => els.maxtokOut.textContent = els.maxtok.value);
}
