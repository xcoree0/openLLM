// ==========================================================================
// runtime.js — modüller arasında paylaşılan, kalıcı OLMAYAN çalışma zamanı
// durumu. Kalıcı veriler için state.js kullanılır.
// ==========================================================================

export const Runtime = {
  client: null,        // NvidiaClient örneği
  grouped: { chat: [], embed: [], rerank: [], guard: [] },
  chatModel: null,      // seçili metin modeli id'si
  agentModel: null,
  imageCatalog: [],
  videoCatalog: [],
  imageModel: null,     // seçili görsel katalog nesnesi
  videoModel: null,     // seçili video katalog nesnesi
};
