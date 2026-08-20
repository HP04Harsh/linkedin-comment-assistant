/**
 * providers/nvidia.js
 * NVIDIA NIM / build.nvidia.com (OpenAI-compatible) chat completions.
 * Base URL and auth: https://integrate.api.nvidia.com/v1, Bearer nvapi-...
 */
import { fetchJSON, extractOpenAIComment } from './common.js';

export const id = 'nvidia';

export async function generate({ apiKey, model, prompt, temperature }) {
  const json = await fetchJSON('https://integrate.api.nvidia.com/v1/chat/completions', {
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
