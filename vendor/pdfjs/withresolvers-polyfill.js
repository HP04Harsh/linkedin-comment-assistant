// vendor/pdfjs/withresolvers-polyfill.js
// MV3 extension_pages CSP ('script-src 'self'') blocks inline scripts, so this
// shim lives in a real file loaded BEFORE popup.js's module import of pdf.js.
// The vendored legacy pdf.js build calls Promise.withResolvers (Chrome 119+);
// the extension supports Chrome 110+, where the API is missing.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    var resolve_, reject_;
    var promise = new Promise(function (res, rej) { resolve_ = res; reject_ = rej; });
    return { promise: promise, resolve: resolve_, reject: reject_ };
  };
}
