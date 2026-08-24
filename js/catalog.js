// ==========================================================================
// catalog.js — /v1/models listesini kategorilere ayırma + görsel/video
// modelleri için küratörlü başlangıç kataloğu.
//
// NVIDIA'nın görsel/video NIM'leri /v1/models üzerinden dönmüyor (bu uç
// yalnızca metin/gömme ailesini listeliyor), bu yüzden bilinen birkaç
// örnekle başlıyoruz. Liste zamanla değişebilir — build.nvidia.com/explore
// üzerinden doğrula; her zaman "Özel model ekle" ile kendi girdini
// ekleyebilirsin.
// ==========================================================================

const VISION_HINTS = ['vision', '-vl', 'vl-', 'vlm', 'neva', 'llava', 'paligemma', 'pixtral', 'vila', 'fuyu', 'kosmos', 'florence'];
const EMBED_HINTS = ['embed'];
const RERANK_HINTS = ['rerank', 'ranking'];
const GUARD_HINTS = ['guard', 'safety', 'moderation', 'shield'];
const CODE_HINTS = ['code', 'coder', 'starcoder', 'codestral'];

function idHas(id, hints) {
  const s = id.toLowerCase();
  return hints.some(h => s.includes(h));
}

/**
 * @returns {{ chat: object[], vision: object[], embed: object[], rerank: object[], guard: object[], code: object[] }}
 */
export function categorizeModels(models) {
  const groups = { chat: [], embed: [], rerank: [], guard: [], code: [] };
  for (const m of models) {
    const id = m.id || '';
    const tagged = { ...m, isVision: idHas(id, VISION_HINTS) };
    if (idHas(id, EMBED_HINTS)) groups.embed.push(tagged);
    else if (idHas(id, RERANK_HINTS)) groups.rerank.push(tagged);
    else if (idHas(id, GUARD_HINTS)) groups.guard.push(tagged);
    else if (idHas(id, CODE_HINTS)) groups.chat.push({ ...tagged, isCode: true });
    else groups.chat.push(tagged);
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => a.id.localeCompare(b.id));
  return groups;
}

// -------------------------------------------------------- image catalog --
export const BUILTIN_IMAGE_MODELS = [
  {
    id: 'stabilityai/sdxl-turbo',
    label: 'SDXL Turbo',
    vendor: 'Stability AI',
    desc: 'Tek basamaklı hızlı üretim, taslak/iterasyon için ideal.',
    tags: ['hızlı'],
    invokePath: '/v1/genai/stabilityai/sdxl-turbo',
    family: 'stability-artifacts',
    defaultSteps: 4
  },
  {
    id: 'stabilityai/stable-diffusion-3-medium',
    label: 'Stable Diffusion 3 Medium',
    vendor: 'Stability AI',
    desc: 'Dengeli kalite/hız; genel amaçlı metinden görsele.',
    tags: ['dengeli'],
    invokePath: '/v1/genai/stabilityai/stable-diffusion-3-medium',
    family: 'stability-artifacts',
    defaultSteps: 30
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-large',
    label: 'Stable Diffusion 3.5 Large',
    vendor: 'Stability AI',
    desc: 'Yüksek detay ve komut sadakati; daha yavaş.',
    tags: ['yüksek kalite'],
    invokePath: '/v1/genai/stabilityai/stable-diffusion-3.5-large',
    family: 'stability-artifacts',
    defaultSteps: 40
  }
];

// -------------------------------------------------------- video catalog --
export const BUILTIN_VIDEO_MODELS = [
  {
    id: 'stabilityai/stable-video-diffusion',
    label: 'Stable Video Diffusion',
    vendor: 'Stability AI',
    desc: 'Görselden videoya — sabit bir görseli kısa bir klibe dönüştürür.',
    tags: ['görsel→video'],
    invokePath: '/v1/genai/stabilityai/stable-video-diffusion',
    family: 'image-to-video',
    inputMode: 'image'
  },
  {
    id: 'nvidia/cosmos-1.0-7b-diffusion-text2world',
    label: 'Cosmos 1.0 (7B) Text2World',
    vendor: 'NVIDIA',
    desc: 'Metinden videoya — dünya-model tabanlı üretim, uzun sürebilir (asenkron).',
    tags: ['metin→video', 'yavaş'],
    invokePath: '/v1/cosmos/nvidia/cosmos-1.0-7b-diffusion-text2world',
    family: 'text-to-video',
    inputMode: 'text'
  }
];

// -------------------------------------------------------- custom models --
import { State } from './state.js';

export function loadCustomModels(kind) {
  return State.getJSON(`custom${kind}Models`, []);
}
export function addCustomModel(kind, entry) {
  const list = loadCustomModels(kind);
  list.push(entry);
  State.setJSON(`custom${kind}Models`, list);
  return list;
}
export function removeCustomModel(kind, id) {
  const list = loadCustomModels(kind).filter(m => m.id !== id);
  State.setJSON(`custom${kind}Models`, list);
  return list;
}

export function fullImageCatalog() {
  return [...BUILTIN_IMAGE_MODELS, ...loadCustomModels('Image')];
}
export function fullVideoCatalog() {
  return [...BUILTIN_VIDEO_MODELS, ...loadCustomModels('Video')];
}
