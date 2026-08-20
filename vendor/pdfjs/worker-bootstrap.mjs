// vendor/pdfjs/worker-bootstrap.mjs
// pdf.js runs in a dedicated module Worker whose global does NOT inherit the
// popup page's scripts, so the Promise.withResolvers polyfill added in
// popup.html cannot cover it. The vendored legacy pdf.js build calls
// Promise.withResolvers on both threads; without this polyfill the worker
// throws on Chrome 110-118 and PDF parsing fails. This wrapper is loaded as
// the worker entry point (GlobalWorkerOptions.workerSrc) and imports the
// real worker module after shimming the worker global.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    var resolve_, reject_;
    var promise = new Promise(function (res, rej) { resolve_ = res; reject_ = rej; });
    return { promise: promise, resolve: resolve_, reject: reject_ };
  };
}
import './pdf.worker.min.mjs';
