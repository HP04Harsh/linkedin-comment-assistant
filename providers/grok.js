/**
 * providers/grok.js
 * xAI Grok (OpenAI-compatible) chat completions (https://docs.x.ai).
 */
import { fetchJSON, extractOpenAIComment } from './common.js';

export const id = 'grok';

export async function generate({ apiKey, model, prompt, temperature }) {
  const json = await fetchJSON('https://api.x.ai/v1/chat/completions', {
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
      max_tokens: 500,
    }),
  });
  return extractOpenAIComment(json);
}
