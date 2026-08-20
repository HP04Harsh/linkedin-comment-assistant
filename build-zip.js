/**
 * build-zip.js
 * Creates a clean extension .zip for distribution.
 * Usage:  node build-zip.js
 * Output: site/public/linkedin-ai-extension.zip
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const OUT_DIR = join(ROOT, 'site');
const ZIP_NAME = 'linkedin-ai-extension.zip';
const ZIP_PATH = join(OUT_DIR, ZIP_NAME);
const STAGING = join(ROOT, '.build-staging');

// Files and folders to include in the extension zip.
const INCLUDE_DIRS = ['background', 'content', 'icons', 'popup', 'providers', 'utils'];
const INCLUDE_FILES = ['manifest.json'];

console.log('Building extension zip...\n');

// Clean previous staging.
if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
mkdirSync(STAGING, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// Copy extension files into staging.
for (const dir of INCLUDE_DIRS) {
  const src = join(ROOT, dir);
  if (!existsSync(src)) {
    console.warn(`  warn: ${dir}/ not found, skipping`);
    continue;
  }
  cpSync(src, join(STAGING, dir), { recursive: true });
  console.log(`  + ${dir}/`);
}
for (const file of INCLUDE_FILES) {
  const src = join(ROOT, file);
  if (!existsSync(src)) {
    console.warn(`  warn: ${file} not found, skipping`);
    continue;
  }
  cpSync(src, join(STAGING, file));
  console.log(`  + ${file}`);
}

// Read version from manifest for the zip filename.
let version = 'latest';
try {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  version = manifest.version || version;
} catch (_) { /* ignore */ }

const finalZip = join(OUT_DIR, `linkedin-ai-extension-v${version}.zip`);

// Remove old zips in output dir.
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH);
if (existsSync(finalZip)) rmSync(finalZip);

// Create zip using PowerShell (available on all Windows).
console.log('\n  Zipping...');
try {
  // Compress-Archive works on Windows PowerShell.
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${STAGING}\\*' -DestinationPath '${finalZip}' -Force"`,
    { stdio: 'inherit' }
  );
  // Also create a stable-name copy so the download link always works.
  cpSync(finalZip, ZIP_PATH);
  console.log(`\n  Done!  ${finalZip}`);
  console.log(`  Also:  ${ZIP_PATH}`);
} catch (err) {
  console.error('Failed to create zip:', err.message);
  process.exit(1);
} finally {
  // Clean up staging.
  if (existsSync(STAGING)) rmSync(STAGING, { recursive: true });
}

console.log('\nNext steps:');
console.log('  1. cd site && npx vercel (or connect the repo to Vercel)');
console.log('  2. Share the download link with anyone!');
