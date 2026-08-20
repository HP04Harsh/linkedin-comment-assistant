/**
 * content/easyapply.js
 * LinkedIn Easy Apply auto-fill.
 *
 * Detects the Easy Apply modal, then a floating panel lets the user:
 *   - Fill the current step from the saved resume profile (deterministic).
 *   - Fill ALL steps in a row (clicking Next/Continue/Review), stopping at the
 *     Submit button - the extension NEVER clicks submit.
 *   - Generate missing free-text fields with the AI provider (optional toggle).
 *
 * Runs in an isolated world on https://www.linkedin.com/*.
 */
(function () {
  'use strict';

  const NS = 'lai';

  const MODAL_SELECTORS = [
    '.jobs-easy-apply-modal',
    '.jobs-easy-apply-form',
    'div[role="dialog"] .jobs-easy-apply-form',
    'form.jobs-easy-apply-form',
  ];

  const FOOTER_BTN_SELECTORS = [
    '.jobs-easy-apply-form-footer button',
    '.jobs-easy-apply-modal button.artdeco-button--primary',
    'div[role="dialog"] button.artdeco-button--primary',
  ];

  const NEXT_TEXT = /^(?:next|continue|review)(?:\s|$)/i;
  const SUBMIT_TEXT = /submit/i;

  const FIELD_SELECTORS = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select';

  let profile = null;
  let generateMissing = true;
  let panel = null;
  let statusEl = null;
  let settings = null;        // autoSubmit etc. from the popup
  let job = null;             // { title, company, description } for AI prompts
  let autoFilling = false;    // a fill-all chain is mid-flight

  const STYLE = `
    .${NS}-ea {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      font: 600 12.5px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #1c2333; background: #ffffff; border: 1px solid #cfe0f3;
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.18);
      padding: 10px 12px; width: 210px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .${NS}-ea__row { display: flex; gap: 6px; }
    .${NS}-ea__title {
      font-weight: 700; color: #0a66c2; font-size: 11px; letter-spacing: .2px;
      display: flex; align-items: center; gap: 4px;
      cursor: move; user-select: none; touch-action: none;
    }
    .${NS}-ea__grip { color: #9aa7bd; letter-spacing: -1px; }
    .${NS}-ea button {
      flex: 1; font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #0a66c2; background: #eef4fc; border: 1px solid #cfe0f3;
      border-radius: 999px; padding: 7px 10px; cursor: pointer;
    }
    .${NS}-ea button:hover { background: #ddebfb; }
    .${NS}-ea button:disabled { opacity: .6; cursor: default; }
    .${NS}-ea button.${NS}-ea__primary { color: #fff; background: #0a66c2; border-color: #0a66c2; }
    .${NS}-ea button.${NS}-ea__primary:hover { background: #084f97; }
    .${NS}-ea label { display: flex; align-items: center; gap: 6px; font-weight: 500; cursor: pointer; }
    .${NS}-ea label input { accent-color: #0a66c2; }
    .${NS}-ea__status { font-size: 11px; color: #67718e; font-style: italic; min-height: 14px; }
    .${NS}-ea__status.${NS}-ea__error { color: #c0392b; font-style: normal; }
    .${NS}-ea-skip {
      outline: 2px solid #f59e0b !important; outline-offset: 1px;
      background: #fff7e6 !important;
    }
    .${NS}-ea-filled { outline: 1px solid #22a06b; outline-offset: 0; }
    .${NS}-ea-submit-ready {
      outline: 3px solid #22a06b !important; outline-offset: 3px;
    }
  `;

  function injectStyles() {
    if (document.getElementById(`${NS}-ea-styles`)) return;
    const style = document.createElement('style');
    style.id = `${NS}-ea-styles`;
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  function waitFor(fn, timeoutMs, intervalMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let val = null;
        try { val = fn(); } catch (_) { /* ignore */ }
        if (val) return resolve(val);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  function findModal() {
    for (const sel of MODAL_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const root = el.closest('[role="dialog"], .jobs-easy-apply-modal, .artdeco-modal-base') || el;
      // LinkedIn keeps a closed Easy Apply dialog in the DOM (display:none);
      // only a visible modal counts as open.
      if (isVisible(root)) return root;
    }
    // Fallback for a revamped Easy Apply DOM: any visible dialog that hosts a
    // job-application-looking form.
    for (const dlg of Array.from(document.querySelectorAll('div[role="dialog"]'))) {
      if (!isVisible(dlg)) continue;
      const fields = currentFields(dlg);
      if (fields.length >= 2 && fields.some((el) => JOB_APP_FIELD_RE.test(norm(fieldLabel(el))))) {
        return dlg;
      }
    }
    return null;
  }

  /** Cheap fingerprint of the form content, to detect a step change. */
  function modalSignature(modal) {
    if (!modal) return '';
    const form = modal.querySelector('.jobs-easy-apply-form, form');
    const content = form ? form.innerHTML.length : modal.innerHTML.length;
    const labels = currentFields(modal).map((f) => fieldLabel(f)).join('|');
    return `${content}:${labels}`;
  }

  function pickText(...els) {
    for (const el of els) {
      if (!el) continue;
      const t = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return '';
  }

  /** Best-effort job title / company / description for the AI prompt. */
  function extractJobInfo(root) {
    const q = (sel) => (root && root.querySelector ? root.querySelector(sel) : null);
    const title = pickText(
      q('.jobs-easy-apply-title, .artdeco-entity-lockup__title, [data-test-easy-apply-title], .jobs-details-top-card__position, .job-details-jobs-unified-top-card__job-title, h1, [data-testid="job-title"], [class*="job-title"], [class*="position-title"], legend'),
      document.querySelector('.jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title, .top-card-layout__title')
    );
    const company = pickText(
      q('.jobs-easy-apply-company, .artdeco-entity-lockup__subtitle, [class*="company-name"], [class*="employer"]'),
      document.querySelector('.jobs-unified-top-card__company-name, .job-details-jobs-unified-top-card__company-name, .top-card-layout__second-subline')
    );
    const description = pickText(
      q('.jobs-description__content, .jobs-easy-apply-content__description, [data-test-description]'),
      document.querySelector('.jobs-description__content, .jobs-box__html-content, .show-more-less-html__markup')
    ).slice(0, 1500);
    return {
      title: title || (document.title || '').split(' | ')[0],
      company,
      description,
    };
  }

  /** The visible fillable fields inside a form, dialog, or the document. */
  function currentFields(root) {
    root = root || document.body;
    return Array.from(root.querySelectorAll(FIELD_SELECTORS)).filter(isVisible);
  }

  /** A field whose label looks like it belongs to a job application. */
  const JOB_APP_FIELD_RE = /first name|last name|email|phone|current employer|employer|company|university|school|college|degree|years of experience|work authorization|authorized|sponsor|visa|cover letter|resume|cv|linkedin|how did you hear|referral|skills?|job title|position|start date|address|city|zip|postal/;

  function looksLikeApplication(fields) {
    return fields.length >= 3 && fields.some((el) => JOB_APP_FIELD_RE.test(norm(fieldLabel(el))));
  }

  /** Generic (non-LinkedIn) job form: a visible form, dialog, or dense field cluster. */
  function findGenericForm() {
    // Only career/application forms count - the panel must not appear on
    // random generic forms (search bars, login boxes, filters, etc.).
    const forms = Array.from(document.querySelectorAll('form'));
    for (const form of forms) {
      if (!isVisible(form)) continue;
      const fields = currentFields(form);
      if (fields.length >= 3 && looksLikeApplication(fields)) return form;
    }
    const containers = Array.from(document.querySelectorAll(
      '[role="dialog"], [role="main"], main, [class*="application-form"], [class*="apply-form"], [class*="job-application"], [class*="application-"]'
    ));
    for (const c of containers) {
      if (!isVisible(c)) continue;
      const fields = currentFields(c);
      if (fields.length >= 3 && looksLikeApplication(fields)) return c;
    }
    const all = currentFields(document.body);
    return all.length >= 5 && looksLikeApplication(all) ? document.body : null;
  }

  /** Whatever fillable form is currently open: LinkedIn modal or a generic form. */
  function findContext() {
    const modal = findModal();
    if (modal) return { kind: 'modal', modal };
    const form = findGenericForm();
    if (form) return { kind: 'form', root: form };
    return null;
  }

  /** Best-effort human label for a form field. */
  function fieldLabel(el) {
    if (el.id) {
      const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byFor && byFor.textContent.trim()) return byFor.textContent.trim();
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const ariaLb = el.getAttribute('aria-labelledby');
    if (ariaLb) {
      const ref = document.getElementById(ariaLb);
      if (ref && ref.textContent.trim()) return ref.textContent.trim();
    }
    // Classic LinkedIn: label sits right before/after the input inside the
    // form element container, or the container has a label class.
    let host = el.closest('.fb-dash-form-element, .artdeco-text-input__container, .jobs-easy-apply-form-element, [data-test-form-builder-field], .job-details-jobs-unified-top-card');
    if (host) {
      const labelEl = host.querySelector('.artdeco-text-input__label, .fb-dash-form-element__label, label');
      if (labelEl && labelEl.textContent.trim() && !labelEl.querySelector(FIELD_SELECTORS)) {
        return labelEl.textContent.trim();
      }
    }
    // Generic forms: a <label> that wraps the input, or a fieldset legend.
    const wrap = el.closest('label');
    if (wrap) {
      let t = wrap.textContent.replace(/\s+/g, ' ').trim();
      if (el.value) t = t.replace(el.value, '');
      t = t.trim();
      if (t && t.length <= 120) return t;
    }
    const fs = el.closest('fieldset');
    if (fs) {
      const legend = fs.querySelector('legend');
      if (legend && legend.textContent.trim()) return legend.textContent.trim();
    }
    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
    return '';
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[\s_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function firstLastName(profile) {
    const parts = (profile.name || '').trim().split(/\s+/);
    if (!parts.length) return { first: '', last: '' };
    const first = parts[0];
    const last = parts.slice(1).join(' ');
    return { first, last };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const numberFrom = (s) => {
    const m = String(s).match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  };

  /** Best-effort select: exact text, then value/number matches, then thresholds. */
  function setSelectValue(sel, value) {
    const options = Array.from(sel.options).filter((o) => o.value !== '' || o.text.trim() !== '');
    const valueNum = Number(String(value).replace(/[^\d.]/g, ''));
    const lower = String(value).toLowerCase();

    const pick = (o) => {
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    // 1) Exact text match (case-insensitive).
    for (const o of options) {
      if (o.text.trim().toLowerCase() === lower) return pick(o);
    }

    if (Number.isFinite(valueNum)) {
      // 2) Option's VALUE attribute carries the same number (e.g. value="2").
      for (const o of options) {
        if (numberFrom(o.value) === valueNum) return pick(o);
      }
      // 3) Option TEXT starts with the same number.
      for (const o of options) {
        if (numberFrom(o.text) === valueNum) return pick(o);
      }
      // 4) Threshold-style options ("X+ years"): largest X <= desired.
      let best = null;
      for (const o of options) {
        const n = numberFrom(o.text);
        if (!Number.isFinite(n) || !/\+/.test(o.text)) continue;
        if (n <= valueNum && (!best || n > best.n)) best = { o, n };
      }
      if (best) return pick(best.o);
    }

    // 5) Substring / contains fallback.
    let best = null;
    let bestScore = -1;
    for (const o of options) {
      const t = o.text.trim().toLowerCase();
      let score = -1;
      if (t.includes(lower)) score = 2;
      else if (lower.includes(t) && t.length > 1) score = 1;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best) return pick(best);
    return false;
  }

  /** Click a radio/checkbox whose sibling label text matches the value. */
  function clickChoice(inputs, value) {
    const lower = norm(value);
    if (!lower) return false;
    for (const el of inputs) {
      let text = '';
      const lbl = el.closest('label');
      text = (lbl ? lbl.textContent : '') || el.getAttribute('aria-label') || '';
      const normText = norm(text);
      if (normText.includes(lower) || lower.includes(normText)) {
        if (!el.checked) el.click();
        return true;
      }
    }
    return false;
  }

  /** Add one skill through LinkedIn's "Add a skill" typeahead. */
  async function addSkill(profile, input) {
    const skills = (profile.skills || []).slice(0, 30);
    const added = [];
    for (const skill of skills) {
      setNativeValue(input, skill);
      const suggestion = await waitFor(() => {
        const opts = Array.from(document.querySelectorAll('.artdeco-typeahead__suggestion, .artdeco-typeahead__results li, [role="option"]'))
          .filter((o) => {
            const r = o.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
        return opts.find((o) => norm(o.textContent).includes(norm(skill))) || null;
      }, 2500, 120);
      if (suggestion) {
        suggestion.click();
        added.push(skill);
      } else {
        // Fall back to typing Enter to create the skill chip.
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        added.push(skill);
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    return added;
  }

  async function generateFieldValue(label, type, maxLength) {
    if (!generateMissing) return null;
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_FIELD',
        payload: { field: { label, type, maxLength }, profile, job },
      });
      if (res && res.ok && res.text) return res.text;
    } catch (_) { /* fall through */ }
    return null;
  }

  const SKIP_SUBSTRINGS = [
    // Consequential / legally-sensitive questions: never auto-answer, the
    // user decides these. Everything else is fair game for AI understanding.
    'work authorization', 'authorized to work', 'sponsorship', 'visa',
    'gender', 'race', 'ethnicity', 'veteran', 'disability',
  ];

  function isSkippableSensitive(label) {
    const l = norm(label);
    return SKIP_SUBSTRINGS.some((s) => l.includes(s));
  }

  function valueForLabel(profile, label) {
    const l = norm(label);
    const { first, last } = firstLastName(profile);
    if (l.includes('first name')) return first;
    if (l.includes('last name')) return last;
    if (/^name$/.test(l) || (l.includes('name') && !l.includes('company') && !l.includes('skill'))) return profile.name || '';
    if (l.includes('email')) return profile.email || '';
    if (l.includes('phone') || l.includes('mobile')) return profile.phone || '';
    if (l.includes('linkedin')) return profile.linkedin ? `https://${profile.linkedin}` : '';
    if (l.includes('city') || /^location$/.test(l)) return profile.location ? profile.location.split(',')[0].trim() : '';
    if (l.includes('zip') || l.includes('postal')) return '';
    if (l.includes('current role') || l.includes('job title') || l.includes('current title') || l.includes('position') || l.includes('headline')) {
      return profile.headline || (profile.experience[0] && profile.experience[0].title) || '';
    }
    if (l.includes('current company') || l.includes('employer') || l.includes('company')) {
      return (profile.experience[0] && profile.experience[0].company) || '';
    }
    if (l.includes('school') || l.includes('university') || l.includes('college')) {
      return (profile.education[0] && profile.education[0].school) || '';
    }
    if (l.includes('degree') || l.includes('major') || l.includes('field of study')) {
      return (profile.education[0] && profile.education[0].degree) || '';
    }
    if (l.includes('website') || l.includes('portfolio') || l.includes('github')) {
      return profile.website || '';
    }
    if (l.includes('years') && l.includes('experience')) {
      const yrs = deriveYears();
      if (yrs != null) return String(yrs);
    }
    return '';
  }

  /** All file inputs in the form root, including hidden ones LinkedIn keeps. */
  function findFileInputs(root) {
    return Array.from((root || document).querySelectorAll('input[type="file"]'));
  }

  async function getResumeFile() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_RESUME_FILE' });
      return (res && res.ok && res.file) || null;
    } catch (_) {
      return null;
    }
  }

  function dataUrlToFile(dataUrl, name, type) {
    const comma = String(dataUrl || '').indexOf(',');
    if (comma < 0) return null;
    const mime = type || (dataUrl.slice(0, comma).match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name || 'resume', { type: mime });
  }

  /** Attach the stored CV to an upload input that clearly wants a resume. */
  async function attachResumeIfRelevant(input) {
    const label = norm(fieldLabel(input));
    const accept = String(input.accept || '').toLowerCase();
    const looksLikeResume =
      /resume|cv\b|curriculum|attachment|document|upload/.test(label + ' ' + accept) ||
      (label === '' && accept.includes('.pdf'));
    if (!looksLikeResume) return false;
    const stored = await getResumeFile();
    if (!stored || !stored.dataUrl) return false;
    const file = dataUrlToFile(stored.dataUrl, stored.name, stored.type);
    if (!file) return false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** A radio/checkbox group reads as its fieldset legend (the question),
   *  not the first option's text (a possible answer). */
  function groupLabel(el, label) {
    if (el.type === 'radio' || el.type === 'checkbox') {
      const fs = el.closest('fieldset');
      const legend = fs && fs.querySelector('legend');
      if (legend && legend.textContent.trim()) return legend.textContent.trim();
    }
    return label;
  }

  /** Human-readable description of a field for the AI batch prompt. */
  function describeField(el, label, root) {
    let type = 'text';
    let maxLength = 200;
    const l = norm(label);
    if (el instanceof HTMLTextAreaElement) {
      type = 'textarea';
      maxLength = /cover letter/i.test(l) ? 600 : 400;
    } else if (el instanceof HTMLSelectElement) {
      type = 'select';
      maxLength = 200;
    } else if (el.type === 'radio' || el.type === 'checkbox') {
      type = el.type;
      maxLength = 120;
    } else {
      maxLength = el.maxLength > 0 ? el.maxLength : (isOpenText(l) ? 400 : 200);
    }
    let options = [];
    if (el instanceof HTMLSelectElement) {
      const seen = new Set();
      for (const o of el.options) {
        const t = (o.text || '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        options.push(t);
      }
    } else if ((el.type === 'radio' || el.type === 'checkbox') && el.name) {
      const seen = new Set();
      for (const r of Array.from(root.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`))) {
        const lbl = r.closest('label');
        const t = norm((lbl ? lbl.textContent : '') || r.getAttribute('aria-label') || '');
        if (t && !seen.has(t)) {
          seen.add(t);
          options.push(t);
        }
      }
    }
    return { el, label, type, maxLength, options: options.slice(0, 30) };
  }

  /** Write a value into a control based on its type. */
  function applyValue(el, value, root) {
    try {
      if (el instanceof HTMLSelectElement) {
        return setSelectValue(el, value);
      }
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (!el.name) return false;
        const group = Array.from(root.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`));
        return clickChoice(group, value);
      }
      setNativeValue(el, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Ask the AI to understand and fill several unanswered fields in one go. */
  async function generateFieldValues(pending) {
    if (!generateMissing || !pending.length) return {};
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_FIELDS',
        payload: {
          fields: pending.map((f) => ({
            label: f.label,
            type: f.type,
            maxLength: f.maxLength,
            options: f.options,
          })),
          profile,
          job,
        },
      });
      if (res && res.ok && res.answers) return res.answers;
    } catch (_) { /* fall through */ }
    return {};
  }

  /** Fill all the visible fields in a form (LinkedIn step or generic form). */
  async function fillStep(rootEl) {
    if (!profile) await refreshProfile();
    if (!profile) {
      console.warn(`[${NS}] no profile available to fill from`);
      setStatus('Upload a resume in the extension popup first.', true);
      return { filled: [], skipped: [], generated: [] };
    }
    // Inside a LinkedIn modal, narrow to the current step's form section.
    const root = (rootEl && rootEl.querySelector && rootEl.querySelector('.jobs-easy-apply-form')) || rootEl;
    if (!job) job = extractJobInfo(root);
    const filled = [];
    const skipped = [];
    const generated = [];
    const allLabels = [];
    let cvAttached = 0;

    const fields = currentFields(root);
    for (const el of fields) {
      try { el.classList.remove(`${NS}-ea-skip`, `${NS}-ea-filled`); } catch (_) { /* ignore */ }
    }

    // CV: attach the stored resume file to any matching upload input.
    for (const fi of findFileInputs(root)) {
      const lbl = fieldLabel(fi);
      if (await attachResumeIfRelevant(fi)) {
        cvAttached++;
        filled.push(lbl || 'resume file');
        const host = fi.closest('.jobs-easy-apply-form-element, .fb-dash-form-element, [data-test-form-builder-field]');
        if (host) {
          try { host.classList.add(`${NS}-ea-filled`); } catch (_) { /* ignore */ }
        }
      }
    }

    // Deterministic pass first: known labels fill straight from the resume.
    const pending = [];
    const choiceSeen = new Set();
    for (const el of fields) {
      if (el.type === 'file') continue;
      const label = groupLabel(el, fieldLabel(el));
      const l = norm(label);
      if (label) allLabels.push(label);

      // Skill typeahead input: add chips from the resume.
      if ((l.includes('skill') || /add a skill|type here|search for skills/i.test(label)) && el instanceof HTMLInputElement) {
        try {
          const added = await addSkill(profile, el);
          if (added.length) {
            filled.push(label || 'skills');
            try { el.classList.add(`${NS}-ea-filled`); } catch (_) { /* ignore */ }
            continue;
          }
        } catch (_) { /* ignore */ }
      }

      // Leave sensitive / legally-consequential fields for the user.
      if (isSkippableSensitive(label)) {
        skipped.push(label || 'field');
        try { el.classList.add(`${NS}-ea-skip`); } catch (_) { /* ignore */ }
        continue;
      }

      // One AI entry per radio/checkbox group.
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (!el.name) {
          skipped.push(label || 'field');
          try { el.classList.add(`${NS}-ea-skip`); } catch (_) { /* ignore */ }
          continue;
        }
        if (choiceSeen.has(el.name)) continue;
        choiceSeen.add(el.name);
      }

      const desired = valueForLabel(profile, label);
      if (desired && applyValue(el, desired, root)) {
        filled.push(label || 'field');
        try { el.classList.add(`${NS}-ea-filled`); } catch (_) { /* ignore */ }
        continue;
      }

      pending.push(describeField(el, label, root));
    }

    // AI understanding pass: the model fills whatever the matcher missed.
    const answers = await generateFieldValues(pending);
    let answered = 0;
    // The model numbers answers to match the prompt's N. items; apply each to
    // its own field so a skipped/omitted middle field cannot shift the rest.
    for (const [idx, value] of Object.entries(answers)) {
      const f = pending[Number(idx) - 1];
      if (!f || !value) continue;
      if (applyValue(f.el, value, root)) {
        answered++;
        filled.push(f.label || 'field');
        try { f.el.classList.add(`${NS}-ea-filled`); } catch (_) { /* ignore */ }
      }
    }
    if (answered) generated.push(`${answered} AI`);

    // If the batch call failed entirely, try one AI call per free-text field.
    if (answered === 0) {
      for (const f of pending) {
        if (f.type === 'select' || f.type === 'radio' || f.type === 'checkbox') continue;
        const gen = await generateFieldValue(f.label, f.type, f.maxLength);
        if (gen && applyValue(f.el, gen, root)) {
          filled.push(f.label || 'field');
          try { f.el.classList.add(`${NS}-ea-filled`); } catch (_) { /* ignore */ }
          generated.push(f.label || 'field');
        }
      }
    }

    // Anything still empty is flagged for the user to review.
    for (const f of pending) {
      if (f.el.classList.contains(`${NS}-ea-filled`)) continue;
      skipped.push(f.label || 'field');
      try { f.el.classList.add(`${NS}-ea-skip`); } catch (_) { /* ignore */ }
    }

    if (filled.length === 0 && skipped.length > 0) {
      console.warn(`[${NS}] no fields auto-filled. Detected labels:`, allLabels.join(' | ') || '(none)');
    }

    return { filled, skipped, generated, cv: cvAttached };
  }

  function isOpenText(l) {
    return /tell us about|introduce|cover letter|why do you want|why should we|additional info|anything else|comments|message to the hiring|short answer|bio|profile summary|about yourself|describe|tell me|please explain|what interests you|how would you|notice period|why are you|what makes you|strengths|weaknesses|goals|availability|portfolio|github|projects?/.test(l);
  }

  /** Rough total years of experience from the profile's date ranges. */
  function deriveYears() {
    if (!profile) return null;
    const spans = [];
    for (const e of profile.experience || []) {
      const m = String(e.dates || '').match(/(?:19|20)\d{2}\s*-\s*((?:19|20)\d{2}|present)/i);
      if (!m) continue;
      const start = Number(String(e.dates).match(/(?:19|20)\d{2}/)[0]);
      const end = /present/i.test(m[1]) ? new Date().getFullYear() : Number(m[1]);
      spans.push({ start, end });
    }
    if (!spans.length) return null;
    const min = Math.min(...spans.map((s) => s.start));
    const max = Math.max(...spans.map((s) => s.end));
    return Math.max(0, max - min);
  }

  function nextButton(modal) {
    for (const sel of FOOTER_BTN_SELECTORS) {
      const btns = Array.from(modal.querySelectorAll(sel)).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (btns.length) return btns[btns.length - 1];
    }
    return null;
  }

  async function fillAll(modal, depth) {
    if (depth > 15) {
      setStatus('Stopped after many steps - complete the form manually.');
      return;
    }
    // Always fill the current step FIRST, so fields are written even if the
    // Next button or step navigation can't be detected.
    const res = await fillStep(modal);
    setStatus(`Filled: ${res.filled.length}${res.cv ? `, CV attached` : ''}, skipped for review: ${res.skipped.length}${res.generated.length ? `, AI: ${res.generated.length}` : ''}.`);
    const btn = nextButton(modal);
    if (btn && SUBMIT_TEXT.test(btn.textContent)) {
      btn.classList.add(`${NS}-ea-submit-ready`);
      if (settings && settings.autoSubmit) {
        btn.click();
        setStatus('Application submitted. Review the confirmation screen.');
      } else {
        setStatus('All steps filled. Review the highlighted Submit button - auto-submit is OFF.');
      }
      return;
    }
    if (!btn) {
      setStatus('Fields filled. No Next button detected - advance the form manually.');
      return;
    }
    // Advance: LinkedIn reuses the same dialog element across steps, so wait
    // for the form CONTENT to change, not for a different modal element.
    const sig = modalSignature(modal);
    btn.click();
    const waited = await waitFor(() => {
      const m2 = findModal();
      if (!m2) return null;
      return modalSignature(m2) !== sig ? m2 : null;
    }, 5000, 250);
    if (waited) {
      setTimeout(() => fillAll(waited, depth + 1), 500);
    } else {
      setStatus('Step advanced. Click "AI Fill" to continue.');
    }
  }

  /** Run a fill-all chain, marking the auto-fill guard while it is active. */
  async function runFillAll(modal) {
    autoFilling = true;
    try {
      await fillAll(modal, 0);
    } catch (err) {
      console.error(`[${NS}] fillAll error:`, err && err.message);
    } finally {
      autoFilling = false;
    }
  }

  function setStatus(msg, isError) {
    if (!statusEl) return;
    if (statusEl.dataset.laiMsg === msg) {
      statusEl.classList.toggle(`${NS}-ea__error`, !!isError);
      return;
    }
    statusEl.dataset.laiMsg = msg;
    statusEl.textContent = msg;
    statusEl.classList.toggle(`${NS}-ea__error`, !!isError);
  }

  function buildPanel() {
    if (panel && document.body.contains(panel)) return panel;

    injectStyles();
    panel = document.createElement('div');
    panel.className = `${NS}-ea`;
    panel.innerHTML = `
      <div class="${NS}-ea__title" title="Drag to move">
        <span class="${NS}-ea__grip" aria-hidden="true">⠿</span>
        <span class="${NS}-ea__title-text" role="status" aria-live="polite"></span>
      </div>
      <div class="${NS}-ea__row">
        <button type="button" id="${NS}-ea-fill" class="${NS}-ea__primary">🤖 Auto-fill</button>
      </div>
      <label><input type="checkbox" id="${NS}-ea-ai" checked /> AI for missing fields</label>
      <div class="${NS}-ea__status" role="status" aria-live="polite"></div>
    `;
    document.body.appendChild(panel);

    // Draggable panel: grab the title bar and move it anywhere on screen.
    const dragTitle = panel.querySelector(`.${NS}-ea__title`);
    let dragging = false;
    let dragOffX = 0;
    let dragOffY = 0;
    dragTitle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      dragOffX = e.clientX - r.left;
      dragOffY = e.clientY - r.top;
      try { dragTitle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      e.preventDefault();
    });
    dragTitle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = Math.min(Math.max(0, e.clientX - dragOffX), Math.max(0, window.innerWidth - panel.offsetWidth));
      const y = Math.min(Math.max(0, e.clientY - dragOffY), Math.max(0, window.innerHeight - panel.offsetHeight));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    const stopDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      try { dragTitle.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    dragTitle.addEventListener('pointerup', stopDrag);
    dragTitle.addEventListener('pointercancel', stopDrag);

    /** Fill the whole form: LinkedIn = advance every step, generic = one pass. */
    async function aiFill() {
      const context = findContext();
      if (!context) return setStatus('No form found on this page.', true);
      if (context.kind === 'modal') {
        await runFillAll(context.modal);
      } else {
        const res = await fillStep(context.root);
        setStatus(`Filled: ${res.filled.length}${res.cv ? `, CV attached` : ''}, skipped for review: ${res.skipped.length}${res.generated.length ? `, AI: ${res.generated.length}` : ''}.`);
      }
    }

    panel.querySelector(`#${NS}-ea-fill`).addEventListener('click', aiFill);

    panel.querySelector(`#${NS}-ea-ai`).addEventListener('change', (e) => {
      generateMissing = e.target.checked;
    });

    statusEl = panel.querySelector(`.${NS}-ea__status`);
    return panel;
  }

  function syncPanel(context) {
    const p = buildPanel();
    // "Auto-fill job forms" toggle in the popup: when off, the panel never
    // appears on screen even if a form is open.
    const enabled = !settings || settings.easyApplyEnabled !== false;
    const present = enabled && !!context;
    p.style.display = present ? 'flex' : 'none';
    const title = p.querySelector(`.${NS}-ea__title-text`);
    if (title) {
      const text = context
        ? (context.kind === 'modal' ? 'LinkedIn Easy Apply form' : 'Job application form')
        : '';
      // Only touch textContent when it actually changes: Blink replaces the
      // text node even for equal values, and this runs from tick() on every
      // DOM mutation - an unconditional write here would feed an infinite
      // MutationObserver loop and peg the page's main thread.
      if (title.dataset.laiTitle !== text) {
        title.dataset.laiTitle = text;
        title.textContent = text;
      }
    }
  }

  async function refreshProfile() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PROFILE' });
      profile = (res && res.ok && res.profile) || null;
    } catch (_) {
      profile = null;
    }
  }

  async function refreshSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res && res.ok && res.settings) {
        settings = res.settings;
        return true;
      }
    } catch (_) {
      // service worker not ready yet - callers retry.
    }
    return false;
  }

  // Popup setting changes (auto-fill / auto-submit) apply without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aiCommentSettings) {
      refreshSettings().then((ok) => {
        if (ok) syncPanel(findContext());
      });
    }
  });

  /**
   * Auto-fill is button-triggered only: the floating "Auto-fill" button
   * detects whatever form is open (LinkedIn Easy Apply modal or a generic
   * job form) and fills it from the resume. Forms are never filled on their
   * own, so the extension can never silently touch a page the user is not
   * actively filling.
   */

  function start() {
    console.log(`[${NS}] easyapply ready on`, location.href);
    refreshProfile();
    injectStyles();
    // Retry until settings are available (a cold-started service worker can
    // miss the first ping) so auto-submit behavior is always known.
    const loadSettings = () => {
      refreshSettings().then((ok) => {
        if (!ok) setTimeout(loadSettings, 1500);
      });
    };
    loadSettings();
    let lastContextType = null;
    const tick = () => {
      const context = findContext();
      const type = context ? (context.kind === 'modal' ? 'modal' : 'form') : null;
      if (type !== lastContextType) {
        console.log(`[${NS}] context ->`, type || 'none');
        lastContextType = type;
      }
      syncPanel(context);
      if (!context) job = null;
    };
    tick();
    setInterval(tick, 1200);
    new MutationObserver(() => tick()).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
