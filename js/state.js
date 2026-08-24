// ==========================================================================
// state.js — tek noktadan kalıcılık (localStorage / sessionStorage) yönetimi
// Hiçbir değer OpenLLM'in kendi bir sunucusuna gönderilmez; tamamen istemcide kalır.
// ==========================================================================

const NS = 'openllm.';

const mem = {}; // remember=session seçildiğinde anahtar burada, sekme kapanınca kaybolur

function storageFor(persist) {
  return persist ? window.localStorage : window.sessionStorage;
}

export const State = {
  // ---- API key ----
  saveApiKey(key, persist) {
    try {
      window.localStorage.removeItem(NS + 'apiKey');
      window.sessionStorage.removeItem(NS + 'apiKey');
    } catch (_) {}
    if (persist) {
      window.localStorage.setItem(NS + 'apiKey', key);
    } else {
      window.sessionStorage.setItem(NS + 'apiKey', key);
    }
  },
  loadApiKey() {
    try {
      return window.localStorage.getItem(NS + 'apiKey') || window.sessionStorage.getItem(NS + 'apiKey') || '';
    } catch (_) { return ''; }
  },
  clearApiKey() {
    try {
      window.localStorage.removeItem(NS + 'apiKey');
      window.sessionStorage.removeItem(NS + 'apiKey');
    } catch (_) {}
  },

  // ---- connection settings ----
  saveConnection(mode, proxyUrl) {
    localStorage.setItem(NS + 'connMode', mode);
    localStorage.setItem(NS + 'proxyUrl', proxyUrl || '');
  },
  loadConnection() {
    return {
      mode: localStorage.getItem(NS + 'connMode') || 'direct',
      proxyUrl: localStorage.getItem(NS + 'proxyUrl') || ''
    };
  },

  // ---- generic JSON get/set (threads, custom models, agent memory…) ----
  getJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(NS + key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  },
  setJSON(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (_) {}
  },
  remove(key) {
    localStorage.removeItem(NS + key);
  },

  // ---- wipe everything OpenLLM stored ----
  wipeAll() {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(NS));
    keys.forEach(k => localStorage.removeItem(k));
    this.clearApiKey();
  }
};

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
