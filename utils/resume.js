/**
 * utils/resume.js
 * Client-side file parsing for resume uploads. Supports .txt/.md (plain text),
 * .pdf (pdf.js) and .docx (JSZip). Returns the extracted raw TEXT; structured
 * profile extraction happens in utils/profile.js.
 *
 * Only runs in the popup (needs DOM-less File APIs + vendored libs).
 */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

function workerSrc() {
  // The bootstrap wrapper shims Promise.withResolvers in the Worker global
  // (the popup-page polyfill does not reach it), then imports the real worker.
  return chrome.runtime.getURL('vendor/pdfjs/worker-bootstrap.mjs');
}

/** Read a File as an ArrayBuffer. */
function readBuffer(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsArrayBuffer(file);
  });
}

function readText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('Could not read the file.'));
    fr.readAsText(file);
  });
}

async function parsePdf(buffer) {
  if (!pdfjsLib.getDocument) throw new Error('PDF parser is not available. Try a .txt file.');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc();
  const doc = await pdfjsLib.getDocument({ data: buffer, useWorkerFetch: false }).promise;
  const parts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js flattens every Tj operator into items WITHOUT newlines, so a
    // page would collapse into a single line and the profile parser would
    // lose the name/skills/experience structure. Rebuild visual lines by
    // inserting '\n' whenever an item's baseline (y) moves down, and decide
    // spaces on the SAME line from the x-gap between chunks: word gaps are
    // wide, letterspacing (resume tooling styles names and section headers
    // with wide tracking, e.g. "H ARSH P ARDHI") is narrow, so only a large
    // gap gets a space.
    let text = '';
    let lastY = null;
    let lineEndX = 0;
    for (const it of content.items) {
      const s = it.str || '';
      if (!s) continue;
      const y = it.transform ? it.transform[5] : 0;
      const x = it.transform ? it.transform[4] : 0;
      const fontSize = it.transform ? Math.abs(it.transform[0]) : 12;
      if (lastY !== null && Math.abs(y - lastY) > 1) {
        text += '\n';
        lineEndX = 0;
      } else if (lastY !== null && x - lineEndX > fontSize * 0.3) {
        text += ' ';
      }
      text += s;
      lastY = y;
      lineEndX = x + (it.width || 0);
    }
    parts.push(text);
  }
  return parts.join('\n');
}

async function parseDocx(buffer) {
  if (typeof JSZip === 'undefined') throw new Error('DOCX parser is not available. Try a .txt file.');
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('Not a valid .docx file.');
  const xml = await entry.async('string');
  const text = xml
    .replace(/<w:p[^>]*>/g, '\n')
    .replace(/<w:tab[^>]*>/g, '  ')
    .replace(/<w:br[^>]*>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  return text;
}

/**
 * Parse a resume File into raw text.
 * Returns { text, kind: 'txt'|'pdf'|'docx' }.
 */
export async function parseResumeFile(file) {
  const name = (file && file.name || '').toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);

  if (ext === 'pdf') {
    return { text: await parsePdf(await readBuffer(file)), kind: 'pdf' };
  }
  if (ext === 'docx') {
    return { text: await parseDocx(await readBuffer(file)), kind: 'docx' };
  }
  if (ext === 'txt' || ext === 'md' || ext === 'text' || TEXT_TYPES.has(file.type)) {
    return { text: await readText(file), kind: 'txt' };
  }
  throw new Error('Unsupported file type. Use .pdf, .docx, .txt or .md.');
}
