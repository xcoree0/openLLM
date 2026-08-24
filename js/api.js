// ==========================================================================
// api.js — NVIDIA NIM (build.nvidia.com) istemcisi
//
// Üç üst-akış (upstream) barındırıcı kullanılır:
//   integrate  -> https://integrate.api.nvidia.com      (chat/models/embeddings, OpenAI uyumlu)
//   genai      -> https://ai.api.nvidia.com              (görsel/video "invoke" uçları)
//   nvcf       -> https://api.nvcf.nvidia.com             (uzun süren video işleri için 202/poll)
//
// NVIDIA bu barındırıcılarda tarayıcıdan doğrudan CORS istekleri için gerekli
// başlıkları döndürmüyor (bkz. README). "direct" modda istek doğrudan atılır ve
// çoğu tarayıcıda engellenir; "proxy" modda istekler kullanıcının kendi dağıttığı
// proxy/worker.js üzerinden aynı yollarla geçirilir.
// ==========================================================================

const HOSTS = {
  integrate: 'integrate.api.nvidia.com',
  genai: 'ai.api.nvidia.com',
  nvcf: 'api.nvcf.nvidia.com'
};

export class NetworkBlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'NetworkBlockedError'; }
}
export class ApiError extends Error {
  constructor(msg, status, body) { super(msg); this.name = 'ApiError'; this.status = status; this.body = body; }
}

export class NvidiaClient {
  constructor({ apiKey, mode = 'direct', proxyUrl = '' }) {
    this.apiKey = apiKey;
    this.mode = mode;
    this.proxyUrl = (proxyUrl || '').replace(/\/$/, '');
  }

  update({ mode, proxyUrl, apiKey }) {
    if (mode !== undefined) this.mode = mode;
    if (proxyUrl !== undefined) this.proxyUrl = (proxyUrl || '').replace(/\/$/, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  _url(kind, path) {
    if (this.mode === 'proxy' && this.proxyUrl) {
      return `${this.proxyUrl}/proxy/${kind}${path}`;
    }
    return `https://${HOSTS[kind]}${path}`;
  }

  async _fetch(kind, path, options = {}) {
    const url = this._url(kind, path);
    const headers = Object.assign(
      { Authorization: `Bearer ${this.apiKey}` },
      options.headers || {}
    );
    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch (err) {
      // fetch() rejects with a bare TypeError when a CORS preflight is blocked —
      // this is by far the most common failure mode against NVIDIA's hosts.
      throw new NetworkBlockedError(
        this.mode === 'direct'
          ? 'Tarayıcı isteği engelledi (muhtemelen CORS). Ayarlar > Bağlantı bölümünden bir vekil (proxy) sunucu tanımlamayı dene.'
          : `Vekil sunucuya ulaşılamadı: ${url}`
      );
    }
    return res;
  }

  async _json(kind, path, options = {}) {
    const res = await this._fetch(kind, path, options);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.error?.message || body?.detail || body?.raw || `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, body);
    }
    return body;
  }

  // -------------------------------------------------------------- models --
  async listModels() {
    const body = await this._json('integrate', '/v1/models');
    return Array.isArray(body?.data) ? body.data : [];
  }

  // ------------------------------------------------------ chat completion --
  // Non-streaming — agent / tool-calling akışında kullanılır (tool_calls'ı
  // parçalar halinde birleştirmek yerine tek seferde almak çok daha güvenilir).
  async chatCompletion({ model, messages, temperature = 0.7, max_tokens = 1024, tools, tool_choice, signal }) {
    const payload = { model, messages, temperature, max_tokens, stream: false };
    if (tools) { payload.tools = tools; payload.tool_choice = tool_choice || 'auto'; }
    return this._json('integrate', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal
    });
  }

  // Streaming — normal sohbet paneli için. onDelta(text) her parça geldiğinde çağrılır.
  async chatCompletionStream({ model, messages, temperature = 0.7, max_tokens = 1024, signal, onDelta }) {
    const res = await this._fetch('integrate', '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model, messages, temperature, max_tokens, stream: true }),
      signal
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let body = null;
      try { body = JSON.parse(text); } catch (_) {}
      throw new ApiError(body?.error?.message || text || `HTTP ${res.status}`, res.status, body);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // olası yarım satırı sakla

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onDelta?.(delta, full); }
        } catch (_) { /* satır tamamlanmamış olabilir, yok say */ }
      }
    }
    return full;
  }

  // ------------------------------------------------------- embeddings --
  async createEmbeddings({ model, input, input_type = 'query' }) {
    return this._json('integrate', '/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: Array.isArray(input) ? input : [input], input_type })
    });
  }

  // ----------------------------------------------------------- reranking --
  // NVIDIA'nın yeniden sıralama (reranking) NIM'leri için uç ve gövde şeması
  // modelden modele değişebiliyor; en yaygın görülen şemayı deniyoruz ve
  // sonucu olabildiğince esnek ayrıştırıyoruz.
  async rerank({ model, query, passages }) {
    return this._json('integrate', '/v1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, query: { text: query }, passages: passages.map(text => ({ text })) })
    });
  }

  // --------------------------------------------------- genai (image/video) --
  // invokePath örn: "/v1/genai/stabilityai/sdxl-turbo"
  // Senkron (200/JSON) ya da asenkron (202 + NVCF-REQID) yanıtları yönetir.
  async invokeGenai({ invokePath, payload, onProgress, signal }) {
    let res = await this._fetch('genai', invokePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal
    });

    if (res.status === 202) {
      const reqId = res.headers.get('nvcf-reqid') || res.headers.get('NVCF-REQID');
      onProgress?.('queued');
      if (!reqId) {
        // 202 döndü ama iz sürülecek kimlik yok — yine de gövdeyi okumayı dene
        const text = await res.text().catch(() => '');
        throw new ApiError('İşlem kabul edildi (202) ama takip kimliği bulunamadı.', 202, text);
      }
      return this._pollNvcf(reqId, onProgress, signal);
    }

    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.error?.message || body?.detail || body?.raw || `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, body);
    }
    onProgress?.('done');
    return body;
  }

  async _pollNvcf(reqId, onProgress, signal, attempt = 0) {
    if (attempt > 90) throw new ApiError('Zaman aşımı: iş çok uzun sürdü.', 408, null);
    await sleep(Math.min(1500 + attempt * 250, 4000));
    onProgress?.('processing', attempt);
    const res = await this._fetch('nvcf', `/v2/nvcf/pexec/status/${reqId}`, {
      headers: { Accept: 'application/json' },
      signal
    });
    if (res.status === 202) return this._pollNvcf(reqId, onProgress, signal, attempt + 1);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.error?.message || body?.detail || body?.raw || `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, body);
    }
    onProgress?.('done');
    return body;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==========================================================================
// Yanıt ayrıştırıcılar — NVIDIA'nın görsel/video NIM'leri arasında JSON şekli
// değişebildiği için olabildiğince çok bilinen biçimi deneyip, hiçbiri
// tutmazsa ham JSON'u kullanıcıya göstermeyi tercih ediyoruz (sessizce
// yanlış veri üretmek yerine).
// ==========================================================================
export function extractImages(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  if (Array.isArray(json.artifacts)) {
    for (const a of json.artifacts) if (a.base64) out.push({ b64: a.base64, seed: a.seed, mime: 'image/png' });
  }
  if (Array.isArray(json.data)) {
    for (const d of json.data) if (d.b64_json) out.push({ b64: d.b64_json, seed: d.seed, mime: 'image/png' });
  }
  if (typeof json.image === 'string') out.push({ b64: stripDataUri(json.image), mime: 'image/png' });
  if (Array.isArray(json.images)) {
    for (const im of json.images) {
      if (typeof im === 'string') out.push({ b64: stripDataUri(im), mime: 'image/png' });
      else if (im?.base64) out.push({ b64: im.base64, seed: im.seed, mime: 'image/png' });
    }
  }
  if (typeof json.b64_json === 'string') out.push({ b64: json.b64_json, mime: 'image/png' });
  return out;
}

export function extractVideo(json) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.video === 'string') return { b64: stripDataUri(json.video), mime: 'video/mp4' };
  if (Array.isArray(json.data) && json.data[0]?.b64_json) return { b64: json.data[0].b64_json, mime: 'video/mp4' };
  if (Array.isArray(json.artifacts) && json.artifacts[0]?.base64) return { b64: json.artifacts[0].base64, mime: 'video/mp4' };
  if (typeof json.url === 'string') return { url: json.url };
  if (Array.isArray(json.assets) && json.assets[0]?.url) return { url: json.assets[0].url };
  return null;
}

function stripDataUri(s) {
  const m = /^data:[^;]+;base64,(.*)$/s.exec(s);
  return m ? m[1] : s;
}
