/**
 * providers/groq.js
 * Groq (OpenAI-compatible) chat completions (https://console.groq.com/docs).
 * Includes auto-retry for rate limits and model fallback.
 */
import { fetchJSON, extractOpenAIComment, ProviderError } from './common.js';

export const id = 'groq';

// Models in preference order. If the user's chosen model fails, we try these.
const FALLBACK_MODELS = ['allam-2-7b', 'groq/compound', 'openai/gpt-oss-20b'];

async function tryGenerate(apiKey, model, prompt, temperature) {
  return fetchJSON('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature,
      max_tokens: 1000,
    }),
  });
}

export async function generate({ apiKey, model, prompt, temperature }) {
  const tried = new Set();
  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];

  for (const m of models) {
    if (tried.has(m)) continue;
    tried.add(m);

    // Retry up to 2 times per model for rate limits
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = await tryGenerate(apiKey, m, prompt, temperature);
        return extractOpenAIComment(json);
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'RATE_LIMIT' && attempt < 1) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        // For model not found or bad request, try next model
        if (err instanceof ProviderError && (err.code === 'BAD_REQUEST' || err.status === 404)) {
          break;
        }
        // For rate limit on last attempt, try next model
        if (err instanceof ProviderError && err.code === 'RATE_LIMIT') {
          break;
        }
        throw err;
      }
    }
  }

  throw new ProviderError(
    'All Groq models are rate-limited right now. Wait 30 seconds and try again.',
    'RATE_LIMIT'
  );
}
