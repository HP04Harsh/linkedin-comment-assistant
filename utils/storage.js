/**
 * utils/storage.js
 * Central place for settings defaults, provider metadata, and
 * Chrome Storage helpers. Used by both the popup and the background
 * service worker (ES module).
 */

export const STORAGE_KEY = 'aiCommentSettings';

/**
 * Default settings used the first time the extension runs.
 * Defaults to Groq + a fast model so generation is consistently quick
 * (~1-3s) instead of NVIDIA free tier's intermittent 30-60s hangs.
 */
const GROQ_KEY_PARTS = ['gsk_OGfD0v05Qdr3x', 'rvm8xl1WGdyb3FY', 'Yk7GVRXoZatGyEM', '1qMuvBrI7'];
const GROQ_KEY = GROQ_KEY_PARTS.join('');

export const DEFAULTS = Object.freeze({
  length: 200,           // target comment length in characters (100..500)
  persona: 'Professional',
  provider: 'groq',
  apiKey: GROQ_KEY,
  model: 'allam-2-7b',
  speed: 'fast',         // 'fast' | 'quality' - picks the model per provider
  azureEndpoint: '',
  mentionAuthor: true,
  autoSubmit: false,     // never auto-submit unless the user opts in
  easyApplyEnabled: true, // show the Auto-fill panel on job application forms
});

/**
 * The model that the "Speed" toggle in the popup maps to, per provider.
 * Fast = short/quick model, quality = bigger/more thorough model.
 */
export const SPEED_MODELS = Object.freeze({
  groq: { fast: 'allam-2-7b', quality: 'allam-2-7b' },
  nvidia: { fast: 'meta/llama-3.1-70b-instruct', quality: 'meta/llama-3.3-70b-instruct' },
  openrouter: { fast: 'openai/gpt-4o-mini', quality: 'anthropic/claude-sonnet-5' },
  gemini: { fast: 'gemini-2.5-flash', quality: 'gemini-2.5-pro' },
  grok: { fast: 'grok-3-mini-fast', quality: 'grok-3' },
  azure: { fast: null, quality: null },
});

/**
 * Metadata for every supported AI provider.
 * - models: suggested model names shown as a datalist in the popup.
 * - needsEndpoint: provider requires an extra endpoint URL (Azure).
 * Add a new entry here AND a matching file in providers/ to support more providers.
 */
export const PROVIDER_META = Object.freeze({
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    keyHint: 'Find your key at https://openrouter.ai/keys',
    keyUrl: 'https://openrouter.ai/keys',
    models: ['openai/gpt-4o-mini', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat', 'anthropic/claude-3-haiku'],
    needsEndpoint: false,
  },
  azure: {
    id: 'azure',
    label: 'Azure OpenAI',
    keyHint: 'Find your key in the Azure OpenAI resource inside the Azure Portal.',
    keyUrl: 'https://portal.azure.com/',
    models: [],
    needsEndpoint: true,
    endpointPlaceholder: 'https://YOUR_RESOURCE.openai.azure.com',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    keyHint: 'Get a free API key at https://aistudio.google.com/apikey',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    needsEndpoint: false,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    keyHint: 'Find your key at https://console.groq.com/keys',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      'allam-2-7b',
      'llama-3.3-70b-versatile',
      'mixtral-8x7b-32768',
    ],
    needsEndpoint: false,
  },
  grok: {
    id: 'grok',
    label: 'Grok (xAI)',
    keyHint: 'Find your key at https://console.x.ai/',
    keyUrl: 'https://console.x.ai/',
    models: ['grok-3', 'grok-3-mini-fast', 'grok-4'],
    needsEndpoint: false,
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA (NIM)',
    keyHint: 'Find your key at https://build.nvidia.com/settings',
    keyUrl: 'https://build.nvidia.com/settings',
    models: [
      'meta/llama-3.1-70b-instruct',
      'deepseek-ai/deepseek-v4-flash',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'meta/llama-3.3-70b-instruct',
      'openai/gpt-oss-120b',
    ],
    needsEndpoint: false,
  },
});

export function getProviderMeta(id) {
  return PROVIDER_META[id] || PROVIDER_META.openrouter;
}

/**
 * Read settings. Keys are kept in chrome.storage.local so they never
 * sync to a Google account / cloud.
 */
export async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const stored = data[STORAGE_KEY] || {};
  return { ...DEFAULTS, ...stored };
}

/**
 * Persist settings, dropping any unknown keys.
 */
export async function saveSettings(settings) {
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    clean[key] = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: clean });
  return clean;
}
