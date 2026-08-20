/**
 * utils/dom.js
 * Generic DOM helpers used by the content scripts.
 * Loaded as a classic script BEFORE linkedin.js / content.js, so its
 * API is exposed on window.__Dom.
 */
(function () {
  'use strict';

  const NS = 'lai';

  /** Create a <button> element with our base class and a click handler. */
  function createButton({ text, title, className, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `${NS}-btn ${className || ''}`.trim();
    btn.title = title || '';
    btn.innerHTML = text;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
  }

  /** Safely run el.closest(selector); returns null on failure. */
  function findClosest(el, selector) {
    if (!el) return null;
    try {
      return el.closest(selector) || null;
    } catch (_) {
      return null;
    }
  }

  /** True only if the element has non-zero layout dimensions. */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el !== document.body) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  window.__Dom = { createButton, findClosest, isVisible };
})();
