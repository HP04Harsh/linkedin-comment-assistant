(() => {
  "use strict";
  if (location.hostname.indexOf("linkedin.com") === -1) return;
  const origFetch = window.fetch;
  if (typeof origFetch !== "function") return;
  window.fetch = function (input, init) {
    let url = null;
    if (typeof input === "string") {
      url = input;
    } else if (input && typeof input === "object") {
      url = input.url;
    }
    if (typeof url === "string" && url.indexOf("chrome-extension://") === 0) {
      return Promise.reject(new TypeError("blocked: chrome-extension probe"));
    }
    return origFetch.apply(this, arguments);
  };
})();
