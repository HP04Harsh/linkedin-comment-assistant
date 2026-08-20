/**
 * providers/common.js
 * Shared request/timeout/error-handling utilities used by every provider.
 */

export const REQUEST_TIMEOUT_MS = 30000;

/** Typed error that carries a stable code for the UI to translate. */
export class ProviderError extends Error {
  constructor(message, code = 'OTHER', status) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

/** Map an HTTP status to a user-friendly ProviderError. */
export function mapHttpError(status, bodyMessage) {
  const msg = bodyMessage || `Request failed with status ${status}.`;
  switch (status) {
    case 400:
      return new ProviderError(bodyMessage || 'Bad request. Check your model name.', 'BAD_REQUEST', status);
    case 401:
    case 403:
      return new ProviderError('Invalid API key or insufficient permissions. Check your API key.', 'INVALID_API_KEY', status);
    case 404:
      return new ProviderError('Not found. Check your model name and endpoint.', 'BAD_REQUEST', status);
    case 429:
      return new ProviderError('Rate limit reached. Wait a moment and try again.', 'RATE_LIMIT', status);
    default:
      if (status >= 500) {
        return new ProviderError('The AI service is temporarily unavailable. Try again shortly.', 'SERVER_ERROR', status);
      }
      return new ProviderError(msg, 'OTHER', status);
  }
}

/**
 * Fetch JSON with a timeout and normalized errors.
 * Only ever called over HTTPS (see providers/index.js notes).
 */
export async function fetchJSON(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw mapHttpError(res.status, body && body.error ? body.error.message : null);
    }
    return body;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err && err.name === 'AbortError') {
      throw new ProviderError('The request timed out. Try again.', 'TIMEOUT');
    }
    throw new ProviderError('Network error. Check your connection and try again.', 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the comment text from an OpenAI-compatible chat response. */
export function extractOpenAIComment(body) {
  const msg = body && body.choices && body.choices[0] && body.choices[0].message;
  // Reasoning models (e.g. gpt-oss-120b on Groq) put the answer in `reasoning`,
  // not `content`. Fall back to reasoning when content is empty.
  const content = msg && (msg.content || msg.reasoning || '');
  if (typeof content !== 'string' || !content.trim()) {
    throw new ProviderError('The AI returned an empty response. Try again.', 'EMPTY_RESPONSE');
  }
  return content;
}

/** Extract the comment text from a Gemini generateContent response. */
export function extractGeminiComment(body) {
  const parts = (body && body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts) || [];
  const text = parts.map((p) => (p && p.text) || '').join('').trim();
  if (!text) {
    throw new ProviderError('The AI returned an empty response. Try again.', 'EMPTY_RESPONSE');
  }
  return text;
}
