/**
 * background/service-worker.js
 * MV3 module service worker.
 * - Routes messages from the popup and content scripts.
 * - Owns API calls (via providers/) so API keys never touch the page.
 * - Builds prompts, normalizes output, retries transient failures.
 */
import { getSettings, saveSettings } from '../utils/storage.js';
import { buildPrompt, buildDMSystemPrompt, buildDMPrompt, buildFieldPrompt, buildFieldsPrompt, parseFieldsAnswer, normalizeComment, fitToLength, isMetaCommentary, addressesWrongPerson, PLACEHOLDER_RE } from '../utils/prompt.js';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../providers/common.js';

/** sendResponse can throw if the receiving context closed mid-flight. */
function sendResponseSafe(sendResponse, data) {
  try {
    sendResponse(data);
  } catch (_) {
    /* sender gone */
  }
}

function toErrorPayload(err) {
  if (err instanceof ProviderError) {
    return { code: err.code, message: err.message };
  }
  return { code: 'OTHER', message: (err && err.message) || 'Something went wrong. Try again.' };
}

/**
 * Remove the post author's full name, first name, and last name from a comment.
 * Used when the "Mention the author" toggle is OFF so the name can never leak
 * even if the model ignored the instruction.
 */
function stripAuthorName(text, name) {
  let out = String(text || '').trim();
  if (!out || !name) return out;
  const parts = String(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return out;
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [esc(name)];
  if (parts[0]) names.push(esc(parts[0]));
  const last = parts.slice(1).join(' ');
  if (last) names.push(esc(last));
  for (const n of names) {
    out = out.replace(new RegExp(`\\b${n}\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').trim();
  }
  // Tidy up leftover punctuation from the removed name (e.g. "Thanks ," / ", ,").
  out = out.replace(/,\s*(?=,|[.!?])/g, '').replace(/^[\s,.;:]+/, '').replace(/[\s,.;:]+$/, '').trim();
  return out;
}

/**
 * Generate a comment for a post.
 * payload: { postData, regenerate, previousComment, history, settings? }
 */
async function generateComment(payload) {
  const stored = await getSettings();
  const settings = { ...stored, ...(payload.settings || {}) };

  const provider = getProvider(settings.provider);
  if (!provider) throw new ProviderError('Unknown AI provider selected.', 'BAD_CONFIG');
  if (!settings.apiKey) {
    throw new ProviderError('Add your API key in the extension settings, then try again.', 'MISSING_API_KEY');
  }
  if (!settings.model) {
    throw new ProviderError('Set a model name in the extension settings, then try again.', 'BAD_CONFIG');
  }

  // If the user attached a resume, use it to personalize the comment so it is
  // written from their own experience instead of sounding like generic AI copy.
  const { aiProfile } = await chrome.storage.local.get('aiProfile');

  const maxChars = Math.max(100, Math.min(500, Number(settings.length) || 200));
  // Comments below this get retried; the final attempt accepts anything >= FINAL_MIN
  // so a very brief post can never hard-fail the whole request.
  const MIN_ACCEPT = Math.max(60, Math.round(maxChars * 0.7));
  const FINAL_MIN = 40;

  let lastError = null;
  let retryNote = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const prompt = buildPrompt(payload.postData, settings, {
        regenerate: !!payload.regenerate,
        previousComment: payload.previousComment,
        history: payload.history,
        profile: aiProfile || null,
        retryNote,
        attempt,
      });
      // Escalate temperature per attempt for fresh, longer wording.
      const temperature = 0.7 + attempt * 0.15;

      let text = await provider.generate({
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: settings.azureEndpoint,
        prompt,
        temperature,
      });

      text = normalizeComment(text);
      text = fitToLength(text, maxChars);
      // Model hedged / leaked meta-commentary instead of the comment itself
      // (e.g. empty post text, "here's a framework...", or it starts DESCRIBING
      // the post instead of commenting): re-roll, the same way we do for
      // too-short output.
      if (isMetaCommentary(text)) {
        retryNote = 'Your previous output summarized the post or described the task instead of commenting. Output ONLY the comment itself - never a summary, framing, or description of the post. Do not open with "X highlights that...", "X shares...", or "The post discusses...". Start with your own direct reaction or point.';
        lastError = new ProviderError('The model returned meta-commentary instead of a comment. Retrying.', 'TOO_SHORT');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // The comment opens by greeting someone who is not the post author -
      // a wrong-post generation. Unlike short/meta output this is never
      // acceptable, so it hard-fails instead of landing an embarrassing
      // comment aimed at the wrong person.
      const author = payload.postData && payload.postData.authorName;
      if (addressesWrongPerson(text, author)) {
        retryNote = `Your previous comment greeted the wrong person. The post author is "${author}". Address the actual author or omit any name.`;
        lastError = new ProviderError('The comment addressed the wrong person. Retrying.', 'WRONG_ADDRESS');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const minLen = attempt === 3 ? FINAL_MIN : MIN_ACCEPT;
      if (text.length < minLen) {
        retryNote = `Your previous comment was only ${text.length} characters. The target length is ${maxChars} characters (about ${Math.max(20, Math.round(maxChars / 5.5))} words). Write a comment close to that length, using the details provided.`;
        lastError = new ProviderError('The comment was too short. Retrying.', 'TOO_SHORT');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // "Mention the author" toggle OFF: make sure the author's name never
      // appears even if the model used it despite the instruction.
      if (!settings.mentionAuthor) text = stripAuthorName(text, author);
      return text;
    } catch (err) {
      lastError = err;
      const transient =
        err instanceof ProviderError &&
        ['TIMEOUT', 'RATE_LIMIT', 'NETWORK', 'SERVER_ERROR', 'TOO_SHORT'].includes(err.code);
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Fill a single job-application field the resume does not cover, using the AI
 * provider. payload: { field: {label,type,maxLength}, profile, job, settings? }.
 */
async function generateField(payload) {
  const stored = await getSettings();
  const settings = { ...stored, ...(payload.settings || {}) };

  const provider = getProvider(settings.provider);
  if (!provider) throw new ProviderError('Unknown AI provider selected.', 'BAD_CONFIG');
  if (!settings.apiKey) {
    throw new ProviderError('Add your API key in the extension settings, then try again.', 'MISSING_API_KEY');
  }
  if (!settings.model) {
    throw new ProviderError('Set a model name in the extension settings, then try again.', 'BAD_CONFIG');
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const system = 'You are helping a job seeker fill in one application field. Respond with ONLY the value for that field - no labels, no quotes, no explanations, no markdown, no "here is my answer".';
      const user = buildFieldPrompt(payload.field, payload.profile, payload.job);
      let text = await provider.generate({
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: settings.azureEndpoint,
        prompt: { system, user },
        temperature: 0.4 + attempt * 0.2,
      });
      text = normalizeComment(text).trim().replace(/^["']+|["']+$/g, '');
      if (!text) {
        lastError = new ProviderError('The model returned an empty answer. Retrying.', 'TOO_SHORT');
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      const max = Number(payload.field && payload.field.maxLength) || 200;
      if (text.length > max) text = fitToLength(text, max);
      return text;
    } catch (err) {
      lastError = err;
      const transient = err instanceof ProviderError && ['TIMEOUT', 'RATE_LIMIT', 'NETWORK', 'SERVER_ERROR'].includes(err.code);
      if (transient && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Fill MANY application fields in one AI call so the model understands them
 * in context. payload: { fields: [{label,type,maxLength,options}], profile,
 * job, settings? }. Returns a map of 1-based field number -> value.
 */
async function generateFields(payload) {
  const stored = await getSettings();
  const settings = { ...stored, ...(payload.settings || {}) };

  const provider = getProvider(settings.provider);
  if (!provider) throw new ProviderError('Unknown AI provider selected.', 'BAD_CONFIG');
  if (!settings.apiKey) {
    throw new ProviderError('Add your API key in the extension settings, then try again.', 'MISSING_API_KEY');
  }
  if (!settings.model) {
    throw new ProviderError('Set a model name in the extension settings, then try again.', 'BAD_CONFIG');
  }

  const fields = Array.isArray(payload.fields) ? payload.fields.slice(0, 30) : [];
  if (!fields.length) return {};

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const system = 'You help a job seeker answer job-application form fields. You output ONLY the numbered "N. Label: value" lines the user asked for - nothing else.';
      const user = buildFieldsPrompt(fields, payload.profile, payload.job);
      const text = await provider.generate({
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: settings.azureEndpoint,
        prompt: { system, user },
        temperature: 0.3,
      });
      const answers = parseFieldsAnswer(text, fields);
      if (Object.keys(answers).length) return answers;
      lastError = new ProviderError('The model returned no usable field answers. Retrying.', 'EMPTY_RESPONSE');
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      lastError = err;
      const transient = err instanceof ProviderError && ['TIMEOUT', 'RATE_LIMIT', 'NETWORK', 'SERVER_ERROR'].includes(err.code);
      if (transient && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

/**
 * Generate a referral / opportunity DM for a LinkedIn message composer.
 * payload: { person: {name, headline, company, companySlug}, jobMatches,
 *           jobsUrl, settings? }
 */
async function generateDM(payload) {
  const stored = await getSettings();
  const settings = { ...stored, ...(payload.settings || {}) };

  const provider = getProvider(settings.provider);
  if (!provider) throw new ProviderError('Unknown AI provider selected.', 'BAD_CONFIG');
  if (!settings.apiKey) {
    throw new ProviderError('Add your API key in the extension settings, then try again.', 'MISSING_API_KEY');
  }
  if (!settings.model) {
    throw new ProviderError('Set a model name in the extension settings, then try again.', 'BAD_CONFIG');
  }

  const { aiProfile } = await chrome.storage.local.get('aiProfile');

  let lastError = null;
  let retryNote = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const prompt = {
        system: buildDMSystemPrompt(),
        user: buildDMPrompt(payload.person, {
          profile: aiProfile || null,
          jobMatches: payload.jobMatches,
          jobsUrl: payload.jobsUrl,
          retryNote,
        }),
      };
      const temperature = 0.6 + attempt * 0.15;

      let text = await provider.generate({
        apiKey: settings.apiKey,
        model: settings.model,
        endpoint: settings.azureEndpoint,
        prompt,
        temperature,
      });
      text = normalizeComment(text);
      if (!text || PLACEHOLDER_RE.test(text)) {
        retryNote = 'Your previous message was empty or contained placeholders like [name] or [company]. Write out the actual details and output ONLY the message text.';
        lastError = new ProviderError('The message was empty or had placeholders. Retrying.', 'TOO_SHORT');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (text.length < 60) {
        retryNote = `Your previous message was only ${text.length} characters - too short for a referral DM. Write a warm message of roughly 200-300 characters.`;
        lastError = new ProviderError('The message was too short. Retrying.', 'TOO_SHORT');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (text.length > 500) {
        retryNote = 'Your previous message was too long (an email, not a DM). Cut it to under 300 characters - short, warm, and to the point.';
        lastError = new ProviderError('The message was too long. Retrying.', 'TOO_LONG');
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return text;
    } catch (err) {
      lastError = err;
      const transient =
        err instanceof ProviderError &&
        ['TIMEOUT', 'RATE_LIMIT', 'NETWORK', 'SERVER_ERROR', 'TOO_SHORT', 'TOO_LONG'].includes(err.code);
      if (transient && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const respond = (data) => sendResponseSafe(sendResponse, data);

  (async () => {
    switch (message && message.type) {
      case 'GET_SETTINGS':
        return { ok: true, settings: await getSettings() };

      case 'SAVE_SETTINGS':
        await saveSettings(message.settings);
        return { ok: true, settings: await getSettings() };

      case 'GENERATE_COMMENT': {
        const text = await generateComment(message.payload || {});
        return { ok: true, text };
      }

      case 'GENERATE_FIELD': {
        const text = await generateField(message.payload || {});
        return { ok: true, text };
      }

      case 'GENERATE_FIELDS': {
        const answers = await generateFields(message.payload || {});
        return { ok: true, answers };
      }

      case 'GENERATE_DM': {
        const text = await generateDM(message.payload || {});
        return { ok: true, text };
      }

      case 'GET_PROFILE': {
        const data = await chrome.storage.local.get('aiProfile');
        return { ok: true, profile: data.aiProfile || null };
      }

      case 'SAVE_RESUME_FILE': {
        const f = message.file;
        if (f && f.dataUrl && f.dataUrl.length > 7 * 1024 * 1024) {
          return { ok: false, error: { code: 'TOO_LARGE', message: 'Resume file is too large to auto-attach.' } };
        }
        await chrome.storage.local.set({ resumeFile: f || null });
        return { ok: true };
      }

      case 'GET_RESUME_FILE': {
        const data = await chrome.storage.local.get('resumeFile');
        return { ok: true, file: data.resumeFile || null };
      }

      case 'SAVE_PROFILE': {
        await chrome.storage.local.set({ aiProfile: message.profile || null });
        return { ok: true };
      }

      case 'CLEAR_PROFILE': {
        await chrome.storage.local.remove(['aiProfile', 'resumeFile']);
        return { ok: true };
      }

      default:
        return { ok: false, error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown message type.' } };
    }
  })().then(respond, (err) => respond({ ok: false, error: toErrorPayload(err) }));

  // Keep the message channel open for the async response.
  return true;
});
