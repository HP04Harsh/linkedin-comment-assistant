/**
 * providers/index.js
 * Registry for all AI providers. To add a new provider:
 *   1. Create providers/my-provider.js exporting { id, generate }.
 *   2. Import it below and add it to the PROVIDERS map.
 *   3. Add matching metadata to PROVIDER_META in utils/storage.js.
 *
 * NOTE: every provider must call HTTPS endpoints only - never plain HTTP.
 */
import * as openrouter from './openrouter.js';
import * as azure from './azure.js';
import * as gemini from './gemini.js';
import * as groq from './groq.js';
import * as grok from './grok.js';
import * as nvidia from './nvidia.js';

const PROVIDERS = { openrouter, azure, gemini, groq, grok, nvidia };

/** Look up a provider module by id, or null if unknown. */
export function getProvider(id) {
  return PROVIDERS[id] || null;
}

/** List every registered provider id. */
export function listProviders() {
  return Object.keys(PROVIDERS);
}
