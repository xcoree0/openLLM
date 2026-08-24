// ==========================================================================
// agent.js — araç çağırma (function calling) destekli istemci-taraflı ajan.
// NVIDIA'nın chat/completions ucu OpenAI uyumlu "tools" şemasını desteklediği
// için klasik metin-tabanlı ReAct ayrıştırması yerine gerçek tool_calls
// kullanılıyor; bu çok daha güvenilir.
// ==========================================================================
import { Runtime } from './runtime.js';
import { toast, setSignalActive, escapeHtml, describeError } from './ui.js';
import { extractImages } from './api.js';

import { fullImageCatalog } from './catalog.js';

const els = {
  modelChip: document.getElementById('agent-model-chip'),
  modelLabel: document.getElementById('agent-model-label'),
  stepsRange: document.getElementById('agent-steps'),
  stepsOut: document.getElementById('agent-steps-out'),
  form: document.getElementById('agent-form'),
  goal: document.getElementById('agent-goal'),
  runBtn: document.getElementById('agent-run'),
  stopBtn: document.getElementById('agent-stop'),
  timeline: document.getElementById('agent-timeline'),
  empty: document.getElementById('agent-empty'),
  toolCalc: document.getElementById('tool-calc'),
  toolClock: document.getElementById('tool-clock'),
  toolImage: document.getElementById('tool-image'),
  toolNotes: document.getElementById('tool-notes'),
};

let running = false;
let shouldStop = false;
let notes = [];

export function setModel(modelId) {
  Runtime.agentModel = modelId;
  els.modelLabel.textContent = modelId;
}

// -------------------------------------------------------------- tools ----
function safeCalc(expr) {
  let i = 0;
  const s = String(expr).replace(/\s+/g, '');
  const peek = () => s[i];
  const err = () => { throw new Error('Geçersiz ifade'); };

  function number() {
    const start = i;
    if (s[i] === '+' || s[i] === '-') i++;
    let digits = 0;
    while (i < s.length && /[0-9]/.test(s[i])) { i++; digits++; }
    if (s[i] === '.') { i++; while (i < s.length && /[0-9]/.test(s[i])) { i++; digits++; } }
    if (digits === 0) err();
    return parseFloat(s.slice(start, i));
  }
  function primary() {
    if (peek() === '(') { i++; const v = expr_(); if (peek() !== ')') err(); i++; return v; }
    return number();
  }
  function power() {
    const base = primary();
    if (peek() === '^') { i++; return Math.pow(base, unary()); }
    return base;
  }
  function unary() {
    if (peek() === '-') { i++; return -unary(); }
    if (peek() === '+') { i++; return unary(); }
    return power();
  }
  function term() {
    let v = unary();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const rhs = unary();
      v = op === '*' ? v * rhs : v / rhs;
    }
    return v;
  }
  function expr_() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const rhs = term();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }
  const result = expr_();
  if (i !== s.length) err();
  if (!isFinite(result)) throw new Error('Sonuç sonlu değil');
  return result;
}

function activeTools() {
  const defs = [];
  if (els.toolCalc.checked) defs.push({
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Temel aritmetik bir ifadeyi hesaplar (+ - * / ^ ve parantez).',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: "Örn: (12+3)*4" } }, required: ['expression'] }
    }
  });
  if (els.toolClock.checked) defs.push({
    type: 'function',
    function: { name: 'get_current_datetime', description: 'Şu anki tarih ve saati (kullanıcının tarayıcı saat dilimine göre) döndürür.', parameters: { type: 'object', properties: {} } }
  });
  if (els.toolImage.checked) defs.push({
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Kısa bir metin isteminden bir görsel üretir ve kullanıcıya gösterir.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }
    }
  });
  if (els.toolNotes.checked) {
    defs.push({ type: 'function', function: { name: 'save_note', description: 'Sonraki adımlar için kısa bir notu hafızaya kaydeder.', parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } } });
    defs.push({ type: 'function', function: { name: 'read_notes', description: 'Şimdiye kadar kaydedilmiş tüm notları döndürür.', parameters: { type: 'object', properties: {} } } });
  }
  return defs;
}

async function runTool(name, args) {
  switch (name) {
    case 'calculator': {
      const val = safeCalc(args.expression);
      return { text: `${args.expression} = ${val}`, html: `<code>${escapeHtml(args.expression)} = ${val}</code>` };
    }
    case 'get_current_datetime': {
      const now = new Date();
      return { text: now.toString(), html: escapeHtml(now.toString()) };
    }
    case 'generate_image': {
      const catalog = fullImageCatalog();
      const model = Runtime.imageModel || catalog[0];
      if (!model) return { text: 'Görsel modeli bulunamadı.', html: 'Görsel modeli bulunamadı.' };
      const payload = { text_prompts: [{ text: args.prompt, weight: 1 }], cfg_scale: 7, steps: model.defaultSteps || 25, seed: 0, sampler: 'K_EULER_ANCESTRAL', width: 1024, height: 1024 };
      const json = await Runtime.client.invokeGenai({ invokePath: model.invokePath, payload });
      const images = extractImages(json);
      if (!images.length) return { text: 'Görsel üretilemedi (beklenmeyen yanıt).', html: 'Görsel üretilemedi.' };
      const dataUri = `data:${images[0].mime};base64,${images[0].b64}`;
      return { text: `1 görsel üretildi ve kullanıcıya gösterildi (istem: "${args.prompt}").`, html: `<img src="${dataUri}" alt="üretilen görsel" style="max-width:200px;border-radius:8px;border:1px solid var(--hairline);margin-top:6px;">` };
    }
    case 'save_note': {
      notes.push(args.note);
      return { text: `Not kaydedildi: ${args.note}`, html: `not eklendi: <code>${escapeHtml(args.note)}</code>` };
    }
    case 'read_notes': {
      const text = notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n') : '(henüz not yok)';
      return { text, html: escapeHtml(text).replace(/\n/g, '<br>') };
    }
    default:
      return { text: `Bilinmeyen araç: ${name}`, html: `Bilinmeyen araç: ${name}` };
  }
}

// -------------------------------------------------------------- render ---
let stepCount = 0;
function appendStep(kind, title, bodyHtml) {
  stepCount++;
  els.empty.hidden = true;
  const card = document.createElement('div');
  card.className = 'step-card' + (kind === 'final' ? ' is-final' : '');
  card.innerHTML = `
    <div class="step-head step-kind-${kind}"><span class="step-num">#${stepCount}</span> ${escapeHtml(title)}</div>
    <div class="step-body">${bodyHtml}</div>`;
  els.timeline.appendChild(card);
  els.timeline.scrollTop = els.timeline.scrollHeight;
  return card;
}

function resetTimeline() {
  stepCount = 0;
  els.timeline.innerHTML = '';
  els.empty.hidden = false;
  els.timeline.appendChild(els.empty);
}

// -------------------------------------------------------------- run ------
async function runAgent(e) {
  e.preventDefault();
  if (running) return;
  const goal = els.goal.value.trim();
  if (!goal) { toast('Bir hedef yaz', 'error'); return; }
  if (!Runtime.client) { toast('Önce bağlan', 'error'); return; }
  if (!Runtime.agentModel) { toast('Bir model seç (araç çağırma destekli)', 'error'); return; }

  const tools = activeTools();
  const maxSteps = parseInt(els.stepsRange.value, 10);

  running = true; shouldStop = false; notes = [];
  els.runBtn.hidden = true; els.stopBtn.hidden = false;
  resetTimeline();
  setSignalActive(true, 'violet', 'ajan çalışıyor…');

  const messages = [
    { role: 'system', content: 'Kullanıcının hedefine ulaşmak için gerektiğinde sağlanan araçları kullan. Gereken bilgi elindeyse doğrudan net ve kısa bir nihai cevap ver. Türkçe yanıt ver.' },
    { role: 'user', content: goal }
  ];

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (shouldStop) { appendStep('final', 'Durduruldu', 'Kullanıcı isteğiyle durduruldu.'); break; }

      const res = await Runtime.client.chatCompletion({
        model: Runtime.agentModel,
        messages,
        tools: tools.length ? tools : undefined,
        temperature: 0.4,
        max_tokens: 900
      });
      const msg = res?.choices?.[0]?.message;
      if (!msg) { appendStep('final', 'Hata', 'Model yanıt vermedi.'); break; }

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        appendStep('final', 'Nihai yanıt', escapeHtml(msg.content || '(boş)').replace(/\n/g, '<br>'));
        break;
      }

      if (msg.content) appendStep('thought', 'Düşünce', escapeHtml(msg.content).replace(/\n/g, '<br>'));
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });

      for (const call of toolCalls) {
        if (shouldStop) break;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
        appendStep('action', `Eylem — ${call.function.name}`, `<code>${escapeHtml(JSON.stringify(args))}</code>`);

        let result;
        try { result = await runTool(call.function.name, args); }
        catch (err) { result = { text: `Araç hatası: ${err.message}`, html: `Araç hatası: ${escapeHtml(err.message)}` }; }

        appendStep('observation', 'Gözlem', result.html);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result.text });
      }

      if (step === maxSteps - 1) appendStep('final', 'Adım sınırına ulaşıldı', 'Ajan, ayarlanan maksimum adım sayısına ulaştı.');
    }
  } catch (err) {
    appendStep('final', 'Hata', escapeHtml(describeError(err)));
    toast(describeError(err), 'error');
  } finally {
    running = false;
    els.runBtn.hidden = false; els.stopBtn.hidden = true;
    setSignalActive(false);
  }
}

export function initAgent() {
  els.stepsRange.addEventListener('input', () => els.stepsOut.textContent = els.stepsRange.value);
  els.form.addEventListener('submit', runAgent);
  els.stopBtn.addEventListener('click', () => { shouldStop = true; });
}
