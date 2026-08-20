/**
 * content/content.js
 * Main content script.
 *  1. Injects an always-visible "AI Comment" button into every post's
 *     action bar (Like / Comment / Repost) so the feature is discoverable
 *     without opening the comment box first.
 *  2. Injects an "AI Comment" + "Refresh" toolbar into every comment
 *     composer once it is rendered.
 * Generation happens in the background service worker; results are inserted
 * as DRAFTS only - the extension never submits comments.
 */
(function () {
  'use strict';

  const NS = 'lai';
  const { __Dom, __LinkedInExt } = window;

  let scanTimer = null;
  /** Comments generated for each post (WeakMap keyed by post element). */
  const prevComments = new WeakMap();

  const STYLE = `
    /* --- in-composer toolbar --- */
    .${NS}-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px 2px;
    }
    .${NS}-btn {
      display: inline-flex; align-items: center; gap: 5px;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #0a66c2; background: #eef4fc;
      border: 1px solid #cfe0f3; border-radius: 999px;
      padding: 5px 12px; cursor: pointer;
      transition: background .15s ease, transform .1s ease;
    }
    .${NS}-btn:hover { background: #ddebfb; }
    .${NS}-btn:disabled { opacity: .6; cursor: default; }
    .${NS}-btn--ghost { color: #4a5568; background: #f4f6f9; border-color: #dde3ec; }
    .${NS}-btn--ghost:hover { background: #e9eef4; }
    .${NS}-icn { font-size: 13px; line-height: 1; }
    .${NS}-status { font-size: 11.5px; color: #67718e; font-style: italic; }
    .${NS}-btn.loading .${NS}-icn { display: none; }
    .${NS}-btn.loading::before {
      content: "";
      width: 12px; height: 12px;
      border: 2px solid rgba(10, 102, 194, .3);
      border-top-color: #0a66c2;
      border-radius: 50%;
      animation: ${NS}-spin .7s linear infinite;
    }

    /* --- always-visible action bar button --- */
    .${NS}-action-btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      flex: 1 1 auto;
      height: 40px; padding: 0 8px;
      font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #55607a; background: transparent; border: none; border-radius: 6px;
      cursor: pointer; transition: background .15s ease, color .15s ease;
    }
    .${NS}-action-btn:hover { background: rgba(0, 0, 0, .06); color: #0a66c2; }
    .${NS}-action-btn:disabled { opacity: .6; cursor: default; }
    .${NS}-action-btn .${NS}-icn { font-size: 16px; }
    .${NS}-action-btn.loading .${NS}-icn { display: none; }
    .${NS}-action-btn.loading::before {
      content: "";
      width: 14px; height: 14px;
      border: 2px solid rgba(10, 102, 194, .3);
      border-top-color: #0a66c2;
      border-radius: 50%;
      animation: ${NS}-spin .7s linear infinite;
    }

    @keyframes ${NS}-spin { to { transform: rotate(360deg); } }

    /* --- toast --- */
    .${NS}-toast {
      position: fixed; left: 50%; bottom: 24px;
      transform: translateX(-50%);
      background: #1c2333; color: #fff;
      font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      padding: 10px 16px; border-radius: 10px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .3);
      z-index: 2147483647; max-width: 320px; text-align: center;
      animation: ${NS}-toast-in .2s ease;
    }
    .${NS}-toast--error { background: #c0392b; }
    .${NS}-toast--out {
      opacity: 0; transform: translateX(-50%) translateY(8px);
      transition: opacity .3s ease, transform .3s ease;
    }
    @keyframes ${NS}-toast-in {
      from { opacity: 0; transform: translateX(-50%) translateY(12px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;

  function injectStyles() {
    if (document.getElementById(`${NS}-styles`)) return;
    const style = document.createElement('style');
    style.id = `${NS}-styles`;
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  function showToast(message, isError) {
    const toast = document.createElement('div');
    toast.className = `${NS}-toast${isError ? ` ${NS}-toast--error` : ''}`;
    toast.setAttribute('role', isError ? 'alert' : 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add(`${NS}-toast--out`);
      setTimeout(() => toast.remove(), 350);
    }, 4000);
  }

  /** Poll a predicate until truthy, then resolve with its value. */
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

  function setBtnLoading(btn, loading) {
    btn.disabled = loading;
    btn.classList.toggle('loading', loading);
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  /** Toggle the in-composer loading spinner / disable buttons. */
  function setFormLoading(host, loading) {
    host.setAttribute(`data-${NS}-loading`, loading ? 'true' : 'false');
    host.querySelectorAll(`.${NS}-btn`).forEach((btn) => {
      setBtnLoading(btn, loading);
    });
    const status = host.querySelector(`.${NS}-status`);
    if (status) status.textContent = loading ? 'Generating...' : '';
  }

  /**
   * Ask the background worker for a comment, insert it as a draft and
   * remember it so repeat generations avoid the previous wording.
   */
  async function generateAndInsert(post, editor, { regenerate }) {
    const postData = __LinkedInExt.extractPost(post);
    console.log('[LAI] using', JSON.stringify({
      author: postData.authorName,
      text: (postData.postText || '').slice(0, 120),
      hashtags: (postData.hashtags || []).slice(0, 5),
    }));
    if (!postData.postText) {
      try {
        const info = {
          tag: post.tagName,
          cls: (post.className || '').toString().slice(0, 120),
          attrs: ['data-id', 'data-urn', 'componentkey', 'data-view-name', 'data-activity-urn']
            .map((a) => [a, post.getAttribute(a)])
            .filter(([, v]) => v),
          author: postData.authorName,
          hashtags: postData.hashtags,
          textSelHits: __LinkedInExt.TEXT_SELECTORS.split(',').map((s) => [s.trim(), post.querySelectorAll(s).length]),
        };
        console.log('[LAI] empty post text on', JSON.stringify(info));
      } catch (_) { /* ignore */ }
    }
    const history = prevComments.get(post) || [];
    const response = await chrome.runtime.sendMessage({
      type: 'GENERATE_COMMENT',
      payload: {
        postData,
        regenerate: !!regenerate,
        previousComment: history[history.length - 1],
        history,
      },
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error && response.error.message) || 'Generation failed.');
    }
    history.push(response.text);
    if (history.length > 8) history.splice(0, history.length - 8);
    prevComments.set(post, history);
    __LinkedInExt.insertCommentText(editor, response.text);
    console.log('[LAI] inserted for', JSON.stringify(postData.authorName), '->', JSON.stringify(response.text));
    try {
      document.documentElement.setAttribute('data-lai-debug', JSON.stringify({
        author: postData.authorName,
        postText: (postData.postText || '').slice(0, 160),
        text: response.text,
        previous: history[history.length - 2],
        editorInDom: document.body.contains(editor),
        postInDom: document.body.contains(post),
      }));
    } catch (_) { /* ignore */ }
    editor.focus();
    showToast('Draft added. Review it, then click Post.');
  }

  /** Nearest live comment editor to an element (handles React re-renders). */
  function nearestEditor(el) {
    const editors = __LinkedInExt.findCommentEditors(document);
    if (!editors.length) return null;
    let rect = null;
    try {
      rect = el && el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!rect) return editors[0];
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let best = null;
    let bestDist = Infinity;
    editors.forEach((ed) => {
      let er = null;
      try {
        er = ed.getBoundingClientRect();
      } catch (_) {
        return;
      }
      if (!er || (er.width === 0 && er.height === 0)) return;
      const d = Math.abs(er.left + er.width / 2 - cx) + Math.abs(er.top + er.height / 2 - cy);
      if (d < bestDist) {
        bestDist = d;
        best = ed;
      }
    });
    return best;
  }

  /** The editor for a toolbar host if still attached, else the nearest live one. */
  function getLiveEditor(host) {
    const editor = __LinkedInExt.getCommentEditor(host);
    if (editor && document.body.contains(editor)) return editor;
    return nearestEditor(host);
  }

  /**
   * The comment editor that belongs to a post: one nested inside it, or a
   * detached one whose post resolves to this post (portaled composers).
   */
  function editorForPost(post) {
    const editor = __LinkedInExt.findCommentEditor(post);
    if (editor) return editor;
    let pr = null;
    try {
      pr = post.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!pr || (pr.width === 0 && pr.height === 0)) return null;
    let best = null;
    let bestDist = Infinity;
    __LinkedInExt.findCommentEditors(document).forEach((ed) => {
      if (!document.body.contains(ed)) return;
      if (__LinkedInExt.findPostByPosition(ed) !== post) return;
      let er = null;
      try {
        er = ed.getBoundingClientRect();
      } catch (_) {
        return;
      }
      if (!er) return;
      const d = Math.abs(er.top - pr.bottom) + Math.abs(er.left - pr.left);
      if (d < bestDist) {
        bestDist = d;
        best = ed;
      }
    });
    return best;
  }

  /** Return the editor for a toolbar host, opening the comment box if needed. */
  async function ensureEditor(host, post) {
    const live = getLiveEditor(host);
    if (live) return live;
    post = post || __LinkedInExt.findParentPost(host) || __LinkedInExt.findPostByPosition(host);
    if (!post || !__LinkedInExt.openCommentBox(post)) return null;
    return waitFor(() => getLiveEditor(host), 5000, 150);
  }

  /** Click handler for the in-composer toolbar buttons. */
  async function handleToolbarGenerate(host, regenerate) {
    if (host.getAttribute(`data-${NS}-loading`) === 'true') return;
    const editor = __LinkedInExt.getCommentEditor(host) || host;
    const post =
      __LinkedInExt.findParentPost(host) ||
      __LinkedInExt.findParentPost(editor) ||
      __LinkedInExt.findPostByPosition(editor) ||
      __LinkedInExt.findPostByIdentity(editor, host) ||
      __LinkedInExt.findPostByIdentity(host, host);
    if (!post) {
      showToast('Could not locate the LinkedIn post.', true);
      return;
    }
    setFormLoading(host, true);
    try {
      const liveEditor = await ensureEditor(host, post);
      if (!liveEditor) throw new Error('Could not find the comment box.');
      await generateAndInsert(post, liveEditor, { regenerate });
    } catch (err) {
      showToast((err && err.message) || 'Something went wrong. Try again.', true);
    } finally {
      setFormLoading(host, false);
    }
  }

  /** Click handler for the always-visible action-bar button. */
  async function handleActionGenerate(post, btn) {
    if (btn.disabled) return;
    setBtnLoading(btn, true);
    try {
      // Always resolve fresh from the live button - never trust the captured
      // post reference. The button sits inside the action bar of the post it
      // belongs to, and LinkedIn's virtualized feed RECYCLES DOM nodes: a
      // captured element can silently point at a node that now renders a
      // DIFFERENT post. Ancestor climbing from the button beats any captured
      // reference; identity/geometry are only fallbacks for the rare case
      // where the button is not nested in a post at all (fully detached).
      const captured = document.body.contains(post) ? post : null;
      const livePost = __LinkedInExt.findParentPost(btn);
      post =
        livePost ||
        __LinkedInExt.findPostByIdentity(post, btn) ||
        __LinkedInExt.findPostByPosition(btn);
      if (!post) throw new Error('Could not locate the LinkedIn post.');
      if (captured && captured !== post) {
        try {
          const a = __LinkedInExt.extractPost(captured).authorName;
          const b = __LinkedInExt.extractPost(post).authorName;
          if (a && b && a !== b) {
            console.log('[LAI] live button post differs from captured post', JSON.stringify({ captured: a, live: b }));
          }
        } catch (_) { /* ignore */ }
      }
      let editor = editorForPost(post);
      if (!editor) {
        if (!__LinkedInExt.openCommentBox(post)) throw new Error('Could not open the comment box.');
        editor = await waitFor(() => editorForPost(post), 6000, 150);
        if (!editor) throw new Error('Could not find the comment box.');
      }
      await generateAndInsert(post, editor, { regenerate: false });
    } catch (err) {
      showToast((err && err.message) || 'Something went wrong. Try again.', true);
    } finally {
      setBtnLoading(btn, false);
    }
  }

  /** Inject the toolbar into a comment composer container. */
  function injectToolbar(host) {
    if (!host) return;
    if (host.hasAttribute(`data-${NS}-injected`)) return;
    if (host.querySelector(`[data-${NS}-injected="true"]`)) return;

    const toolbar = document.createElement('div');
    toolbar.className = `${NS}-toolbar`;

    const generateBtn = __Dom.createButton({
      text: `<span class="${NS}-icn">🤖</span> AI Comment`,
      title: 'Generate an AI comment for this post',
      className: `${NS}-btn--primary`,
      onClick: () => handleToolbarGenerate(host, false),
    });
    const refreshBtn = __Dom.createButton({
      text: `<span class="${NS}-icn">🔄</span> Refresh`,
      title: 'Generate a new, different comment',
      className: `${NS}-btn--ghost`,
      onClick: () => handleToolbarGenerate(host, true),
    });
    const status = document.createElement('span');
    status.className = `${NS}-status`;

    toolbar.appendChild(generateBtn);
    toolbar.appendChild(refreshBtn);
    toolbar.appendChild(status);

    host.setAttribute(`data-${NS}-injected`, 'true');
    host.insertBefore(toolbar, host.firstChild);
  }

  /** Inject the always-visible AI button into a post's action bar. */
  function injectActionButton(post) {
    // If React re-rendered the post and wiped our button out, the data flag
    // stays but the button is gone - re-inject in that case.
    if (post.hasAttribute(`data-${NS}-action`) && post.querySelector(`.${NS}-action-btn`)) return;
    const bar = __LinkedInExt.findActionBar(post);
    if (!bar) return; // bar not rendered yet - retried on the next scan
    // A surviving but handler-less button (e.g. React cloned a subtree) is
    // dead weight - replace it rather than stacking duplicates.
    bar.querySelectorAll(`.${NS}-action-btn`).forEach((b) => b.remove());
    const btn = __Dom.createButton({
      text: `<span class="${NS}-icn">🤖</span> AI Comment`,
      title: 'Generate an AI comment for this post',
      className: `${NS}-action-btn`,
      onClick: () => handleActionGenerate(post, btn),
    });
    bar.appendChild(btn);
    post.setAttribute(`data-${NS}-action`, 'true');
  }

  /** Scan the page for posts and comment editors, injecting as needed. */
  function scan() {
    document.querySelectorAll(__LinkedInExt.POST_SELECTORS).forEach((post) => {
      // LinkedIn nests several post-like containers (data-urn, update-v2,
      // data-view-name) inside the outer post shell - only inject into the
      // OUTERMOST match so a post never gets two buttons.
      if (!__LinkedInExt.isTopLevelPost(post)) return;
      injectActionButton(post);
    });

    __LinkedInExt.findCommentEditors(document).forEach((editor) => {
      if (editor.closest(`[data-${NS}-injected="true"]`)) return;
      const host = __LinkedInExt.findInjectParent(editor);
      injectToolbar(host);
    });
  }

  /** Debounced scan so rapid LinkedIn DOM churn does not thrash. */
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 300);
  }

  function start() {
    if (!__Dom || !__LinkedInExt) return;
    injectStyles();
    scheduleScan();
    // LinkedIn's React app hydrates shortly after load; injecting during that
    // window can trigger hydration mismatches, so re-scan once it has settled.
    setTimeout(scheduleScan, 2500);
    // LinkedIn is a SPA - watch for newly rendered posts and comment boxes.
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true });
    // Belt-and-braces: the observer can miss mutations on LinkedIn's heavily
    // virtualized feed, and React swaps post subtrees on re-render. Cheap,
    // idempotent re-scan keeps buttons/toolbars attached.
    setInterval(scheduleScan, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
