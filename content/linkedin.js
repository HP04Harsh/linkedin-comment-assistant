/**
 * content/linkedin.js
 * LinkedIn-specific selectors and post-extraction logic.
 * Loaded as a classic script BEFORE content.js; exposes window.__LinkedInExt.
 *
 * Selectors here are field-tested against LinkedIn's current DOM and include
 * multiple fallbacks (LinkedIn frequently changes class names). The strategy
 * is EDITOR-ANCHORED: we locate contenteditable comment editors first and
 * derive the injection container from them, so a single selector change in
 * LinkedIn's markup can't break the whole extension.
 */
(function () {
  'use strict';

  /**
   * Containers that wrap a single feed post.
   *
   * LinkedIn ships posts under MANY wrapper variants depending on the
   * surface and A/B bucket: legacy class-based wrappers, the new
   * CSS-in-JS shells keyed by data-id / data-urn (both "urn:li:activity"
   * and "urn:li:aggregatedShare"), componentkey rows on the virtualized
   * home feed, and update-components wrappers. Attribute selectors are
   * far more stable than the hashed class names LinkedIn now generates.
   */
  const POST_SELECTORS = [
    'div.feed-shared-update-v2',
    'article.feed-shared-update-v2',
    '.feed-shared-mini-update-v2',
    '.feed-shared-article-module',
    '.feed-shared-news-module',
    '.occludable-update',
    'div[data-id^="urn:li:activity"]',
    'div[data-id^="urn:li:share"]',
    'div[data-urn^="urn:li:activity"]',
    'div[data-urn^="urn:li:aggregatedShare"]',
    'div.update-components-update',
    'div.update-v2',
    '[data-view-name="feed-full-update"]',
    'div[componentkey*="FeedType_MAIN_FEED_RELEVANCE"]',
    'div[componentkey*="FeedType_ORGANIZATION_FEED"]',
  ].join(', ');

  /** Broader set used only for ANCESTOR CLIMBING (never for enumeration). */
  const POST_ANCESTOR_SELECTORS = POST_SELECTORS + ', [data-urn], article';

  /**
   * Comment composer containers, most specific first.
   * An editor's CLOSEST match becomes the toolbar's host element.
   */
  const FORM_SELECTORS = [
    '.comments-comment-box__form-container',
    '.comments-comment-texteditor',
    '.comments-reply-box__form-container',
    '.comments-reply-box',
    '.comments-comment-box',
  ].join(', ');

  /**
   * Contenteditable comment editors inside a post's comment section.
   * Covers LinkedIn's current (.ql-editor / comment-texteditor) and legacy
   * (.comments-comment-box-comment__text-editor) markup.
   */
  const EDITOR_SELECTORS = [
    'div.comments-comment-box-comment__text-editor',
    '.comments-comment-texteditor .ql-editor',
    '.comments-comment-box .ql-editor',
    '.comments-reply-box .ql-editor',
    'div[aria-placeholder*="Add a comment"]',
    'div[aria-label*="Add a comment"]',
    'div[role="textbox"][contenteditable="true"]',
  ].join(', ');

  /** The post composer ("Start a post") must NEVER be treated as a comment box. */
  const SHARE_BOX_SELECTORS = '.share-box, .share-creation-state, .share-actor, .artdeco-modal';

  /** LinkedIn private-message composer (messenger overlay, thread page, profile). */
  const MSG_EDITOR_SELECTORS = 'div.msg-form__contenteditable, div[role="textbox"][aria-label^="Write a message"]';
  /** Recipient name shown in an open messenger conversation header. */
  const MSG_RECIPIENT_SELECTORS = [
    '.msg-overlay-conversation-bubble__title',
    '.msg-overlay-conversation-bubble__header',
    '.msg-thread__title',
    '.msg-entity-lockup__entity-title',
    '.msg-conversation-card__content--person',
  ].join(', ');
  /** Name on a full profile page (fallback when no messenger header is open). */
  const PROFILE_NAME_SELECTORS = [
    'h1.top-card-layout__title',
    'h1.text-heading-xlarge',
    '.artdeco-card h1',
    '.pv-top-card h1',
  ].join(', ');
  const PROFILE_HEADLINE_SELECTORS = [
    '.top-card-layout__headline',
    '.pv-top-card-v2-section__headline',
    '.text-body-medium.break-words',
  ].join(', ');

  /** The post action bar holding Like / Comment / Repost. */
  const ACTION_BAR_SELECTORS = '.feed-shared-social-actions-bar, .social-actions-bar, .feed-shared-social-actions';

  const COMMENT_BUTTON_SELECTORS =
    'button[aria-label="Comment"], button[data-control-name="comment"], button[aria-label*="Comment"]';

  const TEXT_SELECTORS = [
    '.feed-shared-inline-show-more-text',
    '.update-components-text',
    '[data-testid="expandable-text-box"]',
    'span[data-testid="feed-main-content"] .break-words',
    '.feed-shared-text',
    '.feed-shared-update-v2__description-wrapper',
    '[data-testid="social-detail"] .break-words',
    'span[dir="ltr"]',
  ].join(', ');

  const AUTHOR_SELECTOR = [
    '[data-anonymize="person-full-name"]',
    'span[data-anonymize="person-full-name"]',
    '.feed-shared-actor__name',
    '.update-components-actor__title',
    'a[data-anonymize="actorName"] span',
    '[data-testid="actor-name"]',
    '.feed-shared-actor a[href*="/in/"] span',
  ].join(', ');
  const HASHTAG_SELECTOR = 'a[href*="/feed/hashtag/"], a[href*="/hashtag/"]';

  /** True if the element lives inside the share/composer area. */
  function isShareBox(el) {
    if (!el) return false;
    try {
      return !!el.closest(SHARE_BOX_SELECTORS);
    } catch (_) {
      return false;
    }
  }

  /**
   * Find every comment editor under `root` (document or an element),
   * excluding any editor belonging to the share composer.
   */
  function findCommentEditors(root) {
    if (!root) return [];
    const out = [];
    try {
      root.querySelectorAll(EDITOR_SELECTORS).forEach((el) => {
        if (!isShareBox(el)) out.push(el);
      });
    } catch (_) { /* ignore */ }
    return out;
  }

  /** First comment editor inside a post (main composer is first in DOM). */
  function findCommentEditor(post) {
    const editors = findCommentEditors(post);
    return editors[0] || null;
  }

  /**
   * Best container to host the toolbar for a given editor: its closest
   * comment composer container, or the editor's direct parent as a fallback.
   */
  function findInjectParent(editor) {
    if (!editor) return null;
    return editor.closest(FORM_SELECTORS) || editor.parentElement || editor;
  }

  /**
   * Climb from any element to its parent post SHELL.
   *
   * LinkedIn nests several post-like containers inside the outer shell
   * (update-v2 > update-components-update > data-urn wrappers), and comment
   * areas may sit inside an inner wrapper that ALSO matches our selectors.
   * el.closest() would return that INNER wrapper - which lacks the actor
   * block and may contain the composer - so we collect every matching
   * ancestor and pick the outermost one that actually looks like a post
   * (has a Like/Comment/Repost action bar).
   */
  function findParentPost(el) {
    if (!el) return null;
    const matches = [];
    try {
      let cur = el.parentElement;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        if (cur.matches(POST_ANCESTOR_SELECTORS)) matches.push(cur);
        cur = cur.parentElement;
      }
    } catch (_) {
      return null;
    }
    if (!matches.length) return null;
    matches.reverse(); // outermost first
    for (const m of matches) {
      let bars = 0;
      try {
        bars = m.querySelectorAll(ACTION_BAR_SELECTORS).length;
      } catch (_) { /* ignore */ }
      // A real post shell has exactly one action bar (two for a repost that
      // embeds its own actions). Inner comment wrappers have none.
      if (bars >= 1 && bars <= 2) return m;
    }
    return matches[0];
  }

  /**
   * True if `el` is a post match that is NOT nested inside another post
   * match. LinkedIn nests several post-like containers (data-urn, update-v2,
   * data-view-name) inside the outer shell; only the outermost may receive a
   * button or anchor geometry. NOTE: must check the PARENT - el.closest()
   * returns el itself when el matches.
   */
  function isTopLevelPost(el) {
    if (!el) return false;
    try {
      return !(el.parentElement && el.parentElement.closest(POST_SELECTORS));
    } catch (_) {
      return true;
    }
  }

  /**
   * Find the post visually attached to an element (editor, toolbar, button).
   * Falls back to GEOMETRY when the element is not nested inside a post
   * container - LinkedIn occasionally renders comment boxes detached from
   * the post or re-renders the tree, breaking ancestor climbing.
   */
  function findPostByPosition(el) {
    const direct = findParentPost(el);
    if (direct) return direct;

    let rect = null;
    try {
      rect = el && el.getBoundingClientRect();
    } catch (_) {
      return null;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    let best = null;
    let bestDist = Infinity;
    document.querySelectorAll(POST_SELECTORS).forEach((post) => {
      // Skip nested matches so geometry always anchors on the OUTERMOST
      // post wrapper.
      if (!isTopLevelPost(post)) return;
      let pr = null;
      try {
        pr = post.getBoundingClientRect();
      } catch (_) {
        return;
      }
      if (!pr || pr.width === 0 || pr.height === 0) return;
      const inside = cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom;
      if (inside) {
        best = post;
        return;
      }
      const h =
        (pr.left > cx ? pr.left - cx : 0) +
        (cx > pr.right ? cx - pr.right : 0);
      // A comment composer anchors to the post ABOVE it. Posts whose span
      // lies fully BELOW the element are heavily penalized so a detached
      // editor sandwiched between two posts resolves to the right one.
      const below = pr.top >= cy;
      const v = below ? pr.top - cy + 10000 : cy - pr.bottom;
      const dist = h + v;
      if (dist < bestDist) {
        bestDist = dist;
        best = post;
      }
    });
    return best;
  }

  /** Pick the match whose bounds are nearest the anchor element (live button). */
  function nearestByRect(anchor, matches) {
    if (!matches || !matches.length) return null;
    let cx = null;
    let cy = null;
    try {
      const r = anchor && anchor.getBoundingClientRect();
      if (r && (r.width > 0 || r.height > 0)) {
        cx = r.left + r.width / 2;
        cy = r.top + r.height / 2;
      }
    } catch (_) { /* ignore */ }
    if (cx === null) return matches[0];
    let best = null;
    let bestDist = Infinity;
    matches.forEach((m) => {
      let mr = null;
      try {
        mr = m.getBoundingClientRect();
      } catch (_) {
        return;
      }
      if (!mr || (mr.width === 0 && mr.height === 0)) return;
      const d =
        Math.abs(mr.left + mr.width / 2 - cx) +
        Math.abs(mr.top + mr.height / 2 - cy);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    });
    return best || matches[0];
  }

  /** Query-safe attribute value for an attribute selector. */
  function safeAttr(value) {
    return String(value || '').replace(/"/g, '\\"');
  }

  /**
   * Re-locate a post that React detached from the DOM. Matches the stable
   * per-post identity attributes (data-id / data-urn / data-activity-urn)
   * against the live feed so the freshly rendered post shell is found.
   *
   * componentkey is shared by EVERY row on the virtualized feed, so it can
   * never identify a single post - it is only a last resort, disambiguated
   * by geometric proximity to `anchor` (the live button / toolbar host).
   */
  function findPostByIdentity(ref, anchor) {
    if (!ref || !ref.getAttribute) return null;
    const anchorEl = anchor || ref;
    const uniqueAttrs = ['data-id', 'data-urn', 'data-activity-urn'];
    for (const attr of uniqueAttrs) {
      const value = ref.getAttribute(attr);
      if (!value) continue;
      const matches = [];
      document.querySelectorAll(POST_SELECTORS).forEach((post) => {
        if (!isTopLevelPost(post)) return;
        if (post.getAttribute(attr) === value) {
          matches.push(post);
          return;
        }
        try {
          if (post.querySelector(`[${attr}="${safeAttr(value)}"]`)) matches.push(post);
        } catch (_) { /* ignore */ }
      });
      if (matches.length) {
        return matches.length === 1 ? matches[0] : nearestByRect(anchorEl, matches);
      }
    }
    const ck = ref.getAttribute('componentkey');
    if (ck) {
      const matches = [];
      document.querySelectorAll(POST_SELECTORS).forEach((post) => {
        if (!isTopLevelPost(post)) return;
        if (post.getAttribute('componentkey') === ck) {
          matches.push(post);
          return;
        }
        try {
          if (post.querySelector(`[componentkey="${safeAttr(ck)}"]`)) matches.push(post);
        } catch (_) { /* ignore */ }
      });
      if (matches.length) return nearestByRect(anchorEl, matches);
    }
    return null;
  }

  /** The Like/Comment/Repost action bar of a post. */
  function findActionBar(post) {
    if (!post) return null;
    try {
      return post.querySelector(ACTION_BAR_SELECTORS) || null;
    } catch (_) {
      return null;
    }
  }

  /** The "Comment" trigger button inside a post. */
  function findCommentButton(post) {
    if (!post) return null;
    try {
      return post.querySelector(COMMENT_BUTTON_SELECTORS) || null;
    } catch (_) {
      return null;
    }
  }

  /** Click "Comment" to expand the composer. Returns false if not clickable. */
  function openCommentBox(post) {
    const btn = findCommentButton(post);
    if (!btn) return false;
    btn.click();
    return true;
  }

  /**
   * Pull the post body text, collapsed to a single spaced string.
   *
   * Works on a SANITIZED CLONE: the extension's own injected toolbar and
   * action buttons, comment editors (with any leftover draft text), comment
   * composers, and action bars are stripped FIRST so none of that UI text
   * can ever be mistaken for the post body.
   */
  function extractText(post) {
    if (!post) return '';
    let root = null;
    try {
      root = post.cloneNode(true);
      root.querySelectorAll(
        '.lai-toolbar, [data-lai-injected="true"], .lai-action-btn, .lai-btn, .lai-status, ' +
        EDITOR_SELECTORS + ', ' + FORM_SELECTORS + ', ' + ACTION_BAR_SELECTORS +
        ', button, .share-box, .share-creation-state'
      ).forEach((n) => n.remove());
    } catch (_) {
      root = post;
    }

    const candidates = [];
    try {
      root.querySelectorAll(TEXT_SELECTORS).forEach((el) => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) candidates.push(t);
      });
    } catch (_) { /* ignore */ }

    // Nested containers match together (e.g. inline-show-more > break-words):
    // the longest candidate contains the others, so pick it.
    let best = '';
    candidates.forEach((t) => {
      if (t.length > best.length) best = t;
    });

    // No standard text container (image/video post or unknown layout):
    // fall back to the longest meaningful visible text block, skipping the
    // short actor-name spans and action-bar noise.
    if (!best) {
      let longest = '';
      try {
        root.querySelectorAll('span[dir="ltr"], p, [data-testid]').forEach((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length >= 40 && t.length > longest.length) longest = t;
        });
      } catch (_) { /* ignore */ }
      best = longest;
    }

    // Absolute last resort: read the sanitized clone's own innerText. Buttons
    // and the action bar are already gone, so this stays mostly the body.
    if (!best) {
      try {
        const t = (root.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 20) best = t;
      } catch (_) { /* ignore */ }
    }
    return best;
  }

  /** Author name; LinkedIn sometimes appends company info, so take the first line. */
  function extractAuthor(post) {
    // Strategy 1: known selectors
    let el = null;
    try {
      el = post.querySelector(AUTHOR_SELECTOR);
    } catch (_) { /* ignore */ }
    if (el && el.textContent.trim()) return el.textContent.trim().split('\n')[0].trim();

    // Strategy 2: any link to /in/ (profile link) — name is usually the first span
    try {
      const links = post.querySelectorAll('a[href*="/in/"]');
      for (const link of links) {
        // Skip tiny icons, company links, etc.
        const name = (link.querySelector('span') || link).textContent.trim();
        if (name && name.length > 1 && name.length < 80 && !name.includes('@')) {
          return name.split('\n')[0].trim();
        }
      }
    } catch (_) { /* ignore */ }

    // Strategy 3: aria-label patterns like "View X's profile"
    try {
      const aria = post.querySelector('[aria-label*="profile"], [aria-label*="View"][aria-label*="profile"]');
      if (aria) {
        const match = aria.getAttribute('aria-label').match(/(?:View\s+)?(.+?)(?:'s|\u2019s)?\s+profile/i);
        if (match && match[1]) return match[1].trim();
      }
    } catch (_) { /* ignore */ }

    // Strategy 4: data-anonymize on any element
    try {
      const anon = post.querySelector('[data-anonymize]');
      if (anon) {
        const t = anon.textContent.trim();
        if (t && t.length > 1 && t.length < 80) return t.split('\n')[0].trim();
      }
    } catch (_) { /* ignore */ }

    // Strategy 5: the actor container's first meaningful text node
    try {
      const actor = post.querySelector(
        '.feed-shared-actor, .update-components-actor, [data-testid*="actor"], [data-testid*="name"]'
      );
      if (actor) {
        // Look for the first <a> or <span> with a real name
        const candidates = actor.querySelectorAll('a, span');
        for (const c of candidates) {
          const t = c.textContent.trim();
          // Basic heuristic: a name is 2-60 chars, no HTML, no URLs
          if (t && t.length >= 2 && t.length <= 60 && !t.includes('/') && !t.includes('#')) {
            return t;
          }
        }
      }
    } catch (_) { /* ignore */ }

    return '';
  }

  /** Unique hashtags like #technology found on the post. */
  function extractHashtags(post) {
    const tags = new Set();
    post.querySelectorAll(HASHTAG_SELECTOR).forEach((a) => {
      const t = (a.textContent || '').trim();
      if (t) tags.add(t);
    });
    return Array.from(tags);
  }

  /** Extract everything the AI needs about a post. */
  function extractPost(post) {
    return {
      postText: extractText(post),
      authorName: extractAuthor(post),
      hashtags: extractHashtags(post),
      url: window.location.href.split('?')[0],
    };
  }

  /** Locate the comment editor inside a toolbar host (container). */
  function getCommentEditor(container) {
    if (!container) return null;
    let el = null;
    try {
      el = container.matches(EDITOR_SELECTORS) ? container : container.querySelector(EDITOR_SELECTORS);
    } catch (_) {
      return null;
    }
    if (el && !isShareBox(el)) return el;
    return null;
  }

  /**
   * Paste the generated comment into LinkedIn's contenteditable editor.
   * Uses execCommand so LinkedIn receives proper input events and shows
   * the Post button - but the comment is NEVER submitted automatically.
   */
  function insertCommentText(editor, text) {
    if (!editor) return false;
    editor.focus();

    try {
      document.execCommand('selectAll', false, null);
    } catch (_) { /* older engines */ }

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {
      inserted = false;
    }

    // execCommand can report success without actually changing an editor
    // that did not receive focus/selection. Verify the write landed and
    // fall back to a direct assignment if it did not.
    if (!inserted || (editor.textContent || '').trim() !== text) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }

    editor.focus();
    return true;
  }

  /** First non-empty text under a selector list (spaces collapsed). */
  function firstText(selectors, root) {
    const r = root || document;
    try {
      for (const el of r.querySelectorAll(selectors)) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return t;
      }
    } catch (_) { /* ignore */ }
    return '';
  }

  /** The LinkedIn DM composer under `root`, if any. */
  function findMessageEditor(root) {
    try {
      return (root || document).querySelector(MSG_EDITOR_SELECTORS) || null;
    } catch (_) {
      return null;
    }
  }

  /** The DM editor inside a composer container (or the container itself). */
  function getMessageEditor(container) {
    if (!container) return null;
    try {
      return container.matches(MSG_EDITOR_SELECTORS)
        ? container
        : container.querySelector(MSG_EDITOR_SELECTORS);
    } catch (_) {
      return null;
    }
  }

  /**
   * Best-effort recipient of the open DM composer: the messenger thread
   * header first, then the visible profile page (name + headline + company).
   */
  function extractRecipient() {
    const name = firstText(MSG_RECIPIENT_SELECTORS) ||
      firstText(PROFILE_NAME_SELECTORS) ||
      firstText('h1');
    const headline = firstText(PROFILE_HEADLINE_SELECTORS);

    let company = '';
    let companySlug = '';
    let link = null;
    try {
      link = document.querySelector('#experience a[href*="/company/"]') ||
        document.querySelector('a[href*="/company/"]');
    } catch (_) { /* ignore */ }
    if (link) {
      const href = link.getAttribute('href') || '';
      companySlug = (href.match(/\/company\/([^/?#]+)/) || [])[1] || '';
      company = (link.textContent || '').trim();
      if (!company && companySlug) company = companySlug.replace(/[-_]+/g, ' ');
    }
    if (!company) {
      const c = firstText(
        '#experience .pvs-entity__company, .experience-section .pvs-entity__company, .pv-entity__company-summary-info h3'
      );
      if (c) company = c.split('\n')[0].trim();
    }
    return { name, headline, company, companySlug };
  }

  window.__LinkedInExt = {
    POST_SELECTORS,
    FORM_SELECTORS,
    EDITOR_SELECTORS,
    ACTION_BAR_SELECTORS,
    TEXT_SELECTORS,
    MSG_EDITOR_SELECTORS,
    findCommentEditors,
    findCommentEditor,
    findInjectParent,
    findParentPost,
    findPostByPosition,
    findPostByIdentity,
    isTopLevelPost,
    findActionBar,
    findCommentButton,
    openCommentBox,
    getCommentEditor,
    extractPost,
    insertCommentText,
    findMessageEditor,
    getMessageEditor,
    extractRecipient,
  };
})();
