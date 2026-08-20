/**
 * providers/openrouter.js
 * OpenRouter chat completions (https://openrouter.ai/docs).
 */
import { fetchJSON, extractOpenAIComment } from './common.js';

export const id = 'openrouter';

export async function generate({ apiKey, model, prompt, temperature }) {
  const json = await fetchJSON('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-Title': 'LinkedIn AI Comment',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      temperature,
      max_tokens: 500,
    }),
  });
  return extractOpenAIComment(json);
}
