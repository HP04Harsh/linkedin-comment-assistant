/**
 * content/dm.js
 * "DM Now": whenever a LinkedIn message composer is open (messenger overlay,
 * thread page, or the profile message box), injects a button that:
 *   1. Extracts the recipient (name / headline / company) from the open
 *      messenger thread or the profile page.
 *   2. Best-effort fetches the recipient's company jobs page and keeps the
 *      open roles that look like a match for the user's resume skills.
 *   3. Asks the background worker for a personalized referral/opportunity DM
 *      and inserts it as a DRAFT. It is never sent automatically.
 *
 * Runs in an isolated world on https://www.linkedin.com/* after linkedin.js.
 */
(function () {
  'use strict';

  const NS = 'lai';

  const STYLE = `
    .${NS}-dm-btn {
      display: inline-flex; align-items: center; gap: 5px;
      margin: 0 0 6px;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #fff; background: #0a66c2; border: 1px solid #0a66c2;
      border-radius: 999px; padding: 6px 12px; cursor: pointer;
    }
    .${NS}-dm-btn:hover { background: #084f97; }
    .${NS}-dm-btn:disabled { opacity: .6; cursor: default; }
    .${NS}-dm-toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
      background: #1c2333; color: #fff;
      font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      padding: 10px 16px; border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .3);
      z-index: 2147483647; max-width: 320px; text-align: center;
    }
    .${NS}-dm-toast--error { background: #c0392b; }
  `;

  function injectStyles() {
    if (document.getElementById(`${NS}-dm-styles`)) return;
    const s = document.createElement('style');
    s.id = `${NS}-dm-styles`;
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  function showToast(message, isError) {
    const t = document.createElement('div');
    t.className = `${NS}-dm-toast${isError ? ` ${NS}-dm-toast--error` : ''}`;
    t.setAttribute('role', isError ? 'alert' : 'status');
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }

  function findEditor() {
    return document.querySelector(
      '.msg-form__contenteditable, div[role="textbox"][aria-label^="Write a message"]'
    );
  }

  function hostFor(editor) {
    return editor && (editor.closest('.msg-form') || editor.parentElement || editor);
  }

  function injectButton(host) {
    if (!host || host.hasAttribute('data-lai-dm-injected')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${NS}-dm-btn`;
    btn.textContent = '🤖 DM Now';
    btn.title = 'Generate a personalized referral / opportunity DM from this profile';
    btn.addEventListener('click', () => handleDM(btn));
    host.insertBefore(btn, host.firstChild);
    host.setAttribute('data-lai-dm-injected', 'true');
  }

  /**
   * Best-effort: fetch the company's LinkedIn jobs page (same-origin, cookies
   * included) and pull job titles from the server-rendered markup. LinkedIn
   * renders the app shell client-side, so this often returns nothing - in
   * that case the caller still has the jobs URL and falls back gracefully.
   */
  async function fetchCompanyJobs(slug) {
    if (!slug) return { url: null, jobs: [] };
    const url = `https://www.linkedin.com/company/${encodeURIComponent(slug)}/jobs/`;
    const jobs = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return { url, jobs };
      const html = await res.text();
      const titles = new Set();
      const patterns = [
        /<h3[^>]*class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi,
        /<h3[^>]*class="[^"]*job-card-square__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi,
        /<a[^>]*class="[^"]*base-card__full-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(html))) {
          const title = (m[1] || '')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
          if (title && title.length > 3) titles.add(title);
        }
      }
      for (const t of titles) jobs.push({ title: t });
    } catch (_) { /* best-effort */ }
    return { url, jobs };
  }

  /** True if a job title overlaps the resume skills (no resume -> keep all). */
  function matchesProfile(title, profile) {
    const skills = (profile && profile.skills) || [];
    if (!skills.length) return true;
    const t = title.toLowerCase();
    const words = t.split(/[^a-z0-9+.-]+/).filter((w) => w.length >= 3);
    return words.some((w) => skills.some((s) => s.toLowerCase() === w)) ||
      skills.some((s) => s.length >= 4 && t.includes(s.toLowerCase()));
  }

  async function handleDM(btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const ext = window.__LinkedInExt;
      const recipient = ext.extractRecipient();
      const editor = findEditor();
      if (!editor) throw new Error('Message box not found.');

      const profileRes = await chrome.runtime.sendMessage({ type: 'GET_PROFILE' });
      const profile = profileRes && profileRes.ok ? profileRes.profile : null;

      const jobsRes = await fetchCompanyJobs(recipient.companySlug);
      const matches = (jobsRes.jobs || [])
        .filter((j) => matchesProfile(j.title, profile))
        .slice(0, 6);

      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_DM',
        payload: { person: recipient, jobMatches: matches, jobsUrl: jobsRes.url },
      });
      if (!res || !res.ok) {
        throw new Error((res && res.error && res.error.message) || 'Generation failed.');
      }
      ext.insertCommentText(editor, res.text);
      showToast('DM draft added. Review it before sending.');
    } catch (err) {
      showToast((err && err.message) || 'Something went wrong. Try again.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '🤖 DM Now';
    }
  }

  function scan() {
    injectStyles();
    const editor = findEditor();
    if (editor) injectButton(hostFor(editor));
  }

  function start() {
    console.log(`[${NS}] dm ready on`, location.href);
    scan();
    setInterval(scan, 1200);
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
