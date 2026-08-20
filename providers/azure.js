/**
 * providers/azure.js
 * Azure OpenAI chat completions. The "model" setting holds the
 * deployment name; an endpoint URL is required separately.
 */
import { fetchJSON, extractOpenAIComment, ProviderError } from './common.js';

export const id = 'azure';

export async function generate({ apiKey, model, endpoint, prompt, temperature }) {
  if (!endpoint) {
    throw new ProviderError('Azure endpoint is missing. Add it in the extension settings.', 'BAD_CONFIG');
  }
  const base = String(endpoint).replace(/\/+$/, '');
  const url = `${base}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`;

  const json = await fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
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
