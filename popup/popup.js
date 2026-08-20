/**
 * popup/popup.js
 * Restores settings on open, drives the dynamic provider UI,
 * validates inputs, and persists settings via the service worker.
 */
import { getSettings, STORAGE_KEY, DEFAULTS, PROVIDER_META, SPEED_MODELS } from '../utils/storage.js';
import { parseResumeFile } from '../utils/resume.js';
import { extractProfile, isUsable } from '../utils/profile.js';

const $ = (id) => document.getElementById(id);

const els = {
  length: $('length'),
  lengthValue: $('lengthValue'),
  persona: $('persona'),
  personaHint: $('personaHint'),
  mentionAuthor: $('mentionAuthor'),
  provider: $('provider'),
  speed: $('speed'),
  speedHint: $('speedHint'),
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  keyLink: $('keyLink'),
  endpointField: $('endpointField'),
  azureEndpoint: $('azureEndpoint'),
  model: $('model'),
  modelList: $('modelList'),
  modelHint: $('modelHint'),
  save: $('save'),
  status: $('status'),
  resumeFile: $('resumeFile'),
  resumeStatus: $('resumeStatus'),
  profileSummary: $('profileSummary'),
  clearResume: $('clearResume'),
  autoSubmit: $('autoSubmit'),
  easyApply: $('easyApply'),
};

const PERSONA_HINTS = {
  Professional: 'Professional, business-oriented tone.',
  Technical: 'Technically insightful and expertise-driven.',
  Networking: 'Builds rapport and opens a conversation.',
  'Job Seeker': 'Subtle interest in opportunities, never desperate.',
  General: 'Simple and engaging.',
};

/** Show a transient status message in the footer. */
function setStatus(message, isError) {
  els.status.textContent = message;
  els.status.classList.toggle('is-error', !!isError);
  if (message) {
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => {
      els.status.textContent = '';
      els.status.classList.remove('is-error');
    }, 3000);
  }
}

function renderProfileSummary(profile, cvName) {
  if (!profile || !isUsable(profile)) {
    els.profileSummary.hidden = true;
    els.clearResume.hidden = true;
    return;
  }
  const lines = [];
  if (profile.name) lines.push(`<b>${escapeHtml(profile.name)}</b>`);
  const details = [profile.headline, profile.location, profile.email].filter(Boolean).join(' · ');
  if (details) lines.push(escapeHtml(details));
  lines.push(
    `${profile.skills.length} skills · ${profile.experience.length} experience · ` +
    `${profile.education.length} education`,
  );
  if (cvName) lines.push(`<span style="opacity:.75">CV: ${escapeHtml(cvName)} (auto-attached)</span>`);
  els.profileSummary.innerHTML = lines.join('<br>');
  els.profileSummary.hidden = false;
  els.clearResume.hidden = false;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsDataURL(file);
  });
}

async function saveResumeFile(file) {
  if (!file) return { ok: true, attached: false };
  // Auto-attach needs the raw bytes; cap the stored copy to stay well under
  // chrome.storage.local's quota (data URLs inflate the size ~33%).
  if (file.size > 4 * 1024 * 1024) {
    return { ok: true, attached: false, reason: 'CV too large to auto-attach' };
  }
  const dataUrl = await readDataUrl(file);
  const res = await chrome.runtime.sendMessage({
    type: 'SAVE_RESUME_FILE',
    file: { name: file.name, type: file.type, dataUrl },
  });
  if (res && res.ok) return { ok: true, attached: true };
  return { ok: true, attached: false, reason: 'CV could not be stored for auto-attach' };
}

async function handleResumeUpload(file) {
  if (!file) return;
  els.resumeStatus.textContent = 'Parsing…';
  els.resumeStatus.classList.remove('is-error');
  try {
    const { text, kind } = await parseResumeFile(file);
    if (!text || text.trim().length < 20) {
      throw new Error('No text could be read from the file. Try a different resume file.');
    }
    const profile = extractProfile(text);
    if (!isUsable(profile)) {
      throw new Error('Could not extract a usable profile. Try a text-based resume.');
    }
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile });
    if (!res || !res.ok) throw new Error('Could not save the profile. Try again.');
    const cv = await saveResumeFile(file);
    renderProfileSummary(profile, file.name);
    els.resumeStatus.textContent = cv.attached
      ? `Parsed ${kind.toUpperCase()} and saved ✓`
      : `Parsed ${kind.toUpperCase()} ✓ · ${cv.reason || 'CV not attached'}`;
  } catch (err) {
    els.resumeStatus.classList.add('is-error');
    els.resumeStatus.textContent = (err && err.message) || 'Could not parse the resume.';
  }
}

function currentMeta() {
  return PROVIDER_META[els.provider.value] || PROVIDER_META.openrouter;
}

/** The model the current Speed toggle maps to for this provider (or null). */
function speedModel() {
  const byProvider = SPEED_MODELS[els.provider.value] || {};
  return byProvider[els.speed.value] || null;
}

/** Apply the Speed toggle's model mapping to the model field. */
function applySpeedModel() {
  const m = speedModel();
  if (m) els.model.value = m;
}

/** Update the datalist, placeholders and per-provider extras. */
function applyProviderMeta(meta) {
  els.modelList.textContent = '';
  (meta.models || []).forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    els.modelList.appendChild(opt);
  });
  els.model.placeholder = meta.models && meta.models[0] ? `e.g. ${meta.models[0]}` : 'Deployment name';
  els.endpointField.hidden = !meta.needsEndpoint;
  els.keyLink.href = meta.keyUrl;
  els.keyLink.textContent = `Get an API key - ${meta.label}`;
}

function updateLengthValue() {
  els.lengthValue.textContent = `${els.length.value} Characters`;
}

/** Validate inputs; returns an error string or null. */
function validate() {
  const length = Number(els.length.value);
  if (!Number.isInteger(length) || length < 100 || length > 500) {
    return 'Comment length must be between 100 and 500 characters.';
  }
  if (!PROVIDER_META[els.provider.value]) return 'Please choose a valid AI provider.';
  if (!els.model.value.trim()) return 'Please enter a model name.';

  const meta = currentMeta();
  if (meta.needsEndpoint) {
    const ep = els.azureEndpoint.value.trim();
    if (!ep) return 'Please enter your Azure OpenAI endpoint URL.';
    if (!/^https:\/\/.+/.test(ep)) return 'The endpoint must be a valid HTTPS URL.';
  }
  return null;
}

async function onSave() {
  const error = validate();
  if (error) {
    setStatus(error, true);
    return;
  }

  const settings = {
    length: Number(els.length.value),
    persona: els.persona.value,
    mentionAuthor: els.mentionAuthor.checked,
    provider: els.provider.value,
    apiKey: els.apiKey.value.trim(),
    azureEndpoint: els.azureEndpoint.value.trim(),
    model: els.model.value.trim(),
    speed: els.speed.value,
    autoSubmit: els.autoSubmit.checked,
    easyApplyEnabled: els.easyApply.checked,
  };

  try {
    const res = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
    if (res && res.ok) {
      setStatus(settings.apiKey ? 'Settings saved ✓' : 'Saved ✓ (add your API key to generate comments)');
      return;
    }
  } catch (_) { /* fall through to direct write */ }

  // Service worker unreachable or returned an error - write directly.
  try {
    const clean = {};
    for (const key of Object.keys(DEFAULTS)) {
      clean[key] = settings[key] !== undefined ? settings[key] : DEFAULTS[key];
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
    setStatus(settings.apiKey ? 'Settings saved ✓' : 'Saved ✓ (add your API key to generate comments)');
  } catch (_) {
    setStatus('Could not save settings. Try again.', true);
  }
}

function init() {
  getSettings().then((settings) => {
    els.length.value = settings.length;
    updateLengthValue();
    els.persona.value = settings.persona;
    els.personaHint.textContent = PERSONA_HINTS[settings.persona] || '';
    els.mentionAuthor.checked = settings.mentionAuthor;
    els.provider.value = settings.provider;
    els.speed.value = settings.speed;
    els.apiKey.value = settings.apiKey;
    els.azureEndpoint.value = settings.azureEndpoint;
    els.model.value = settings.model;
    els.autoSubmit.checked = settings.autoSubmit;
    els.easyApply.checked = settings.easyApplyEnabled !== false;

    const meta = currentMeta();
    applyProviderMeta(meta);
    // If no model is set yet, prefill the first suggestion for convenience.
    if (!els.model.value) els.model.value = meta.models[0] || '';
  });

  els.length.addEventListener('input', updateLengthValue);

  els.persona.addEventListener('change', () => {
    els.personaHint.textContent = PERSONA_HINTS[els.persona.value] || '';
  });

  els.provider.addEventListener('change', () => {
    const meta = currentMeta();
    applyProviderMeta(meta);
    // Clear stale API key when switching providers (different providers = different keys)
    els.apiKey.value = '';
    // Reset a stale model to the first suggestion for the new provider.
    if (!els.model.value || !(meta.models || []).includes(els.model.value)) {
      els.model.value = (meta.models && meta.models[0]) || '';
    }
    // Prefer the Speed toggle's mapping for the new provider.
    applySpeedModel();
  });

  els.speed.addEventListener('change', applySpeedModel);

  els.toggleKey.addEventListener('click', () => {
    const isPassword = els.apiKey.type === 'password';
    els.apiKey.type = isPassword ? 'text' : 'password';
    els.toggleKey.textContent = isPassword ? '🙈' : '👁';
  });

  els.resumeFile.addEventListener('change', () => {
    const file = els.resumeFile.files && els.resumeFile.files[0];
    if (file) handleResumeUpload(file);
  });

  els.clearResume.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_PROFILE' });
    els.resumeFile.value = '';
    els.resumeStatus.textContent = 'No resume uploaded yet.';
    els.resumeStatus.classList.remove('is-error');
    renderProfileSummary(null);
  });

  chrome.runtime.sendMessage({ type: 'GET_PROFILE' }).then(async (res) => {
    if (res && res.ok && res.profile) {
      let cvName = '';
      try {
        const f = await chrome.runtime.sendMessage({ type: 'GET_RESUME_FILE' });
        cvName = (f && f.ok && f.file && f.file.name) || '';
      } catch (_) { /* CV info is optional */ }
      renderProfileSummary(res.profile, cvName);
      els.resumeStatus.textContent = cvName ? `Resume + CV saved ✓` : 'Resume saved ✓';
    }
  }).catch(() => { /* SW not ready yet - the resume card just stays empty */ });

  els.save.addEventListener('click', onSave);
}

// Module scripts are deferred, so the DOM is ready at this point.
init();
