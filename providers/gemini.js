/**
 * providers/gemini.js
 * Google Gemini generateContent API.
 */
import { fetchJSON, extractGeminiComment } from './common.js';

export const id = 'gemini';

export async function generate({ apiKey, model, prompt, temperature }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const json = await fetchJSON(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      generationConfig: { temperature, maxOutputTokens: 500 },
    }),
  });
  return extractGeminiComment(json);
}
