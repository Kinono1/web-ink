import { createHash } from 'node:crypto';
import path from 'node:path';

export const INTEGRITY_FILE = 'runtime-integrity.json';
const required = ['manifest.json', 'background.js', 'engine.js', 'content-scripts/content.js', 'library.html', 'sidepanel.html', 'pdf.html', 'pdfjs/pdf.worker.min.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (files, name) => Object.hasOwn(files, name);
const safePath = name => typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..');
const payload = files => Object.fromEntries(Object.entries(files).filter(([name]) => name !== INTEGRITY_FILE));

function requireFile(files, name) {
  if (!safePath(name) || !own(files, name) || !files[name]?.length) throw Error(`Incomplete runtime: missing or empty ${name}`);
}
function resource(files, reference, from = 'manifest.json', allowDirectory = false) {
  if (typeof reference !== 'string' || !reference || /^[a-z][a-z\d+.-]*:|^\/\//i.test(reference)) throw Error(`Invalid runtime resource in ${from}: ${reference}`);
  const base = new URL(from, 'https://web-ink.invalid/');
  const resolved = new URL(reference, base);
  const name = decodeURIComponent(resolved.pathname.slice(1));
  if (allowDirectory && name.endsWith('/')) {
    if (!Object.keys(files).some(file => file.startsWith(name))) throw Error(`Incomplete runtime: missing directory ${name}`);
  } else requireFile(files, name);
}

/** Check the known WXT entries and literal output references before creating a seal.
 * The inventory covers dynamic resources too; this is not a general JS parser.
 */
function validateStructure(files, { legacy = false } = {}) {
  for (const name of required) requireFile(files, name);
  if (!legacy) requireFile(files, 'build-info.json');
  for (const name of Object.keys(files)) if (!safePath(name)) throw Error(`Invalid runtime filename: ${name}`);
  const manifest = JSON.parse(files['manifest.json'].toString());
  if (manifest.manifest_version !== 3 || typeof manifest.version !== 'string') throw Error('Invalid runtime manifest');
  if (files['build-info.json']) {
    const info = JSON.parse(files['build-info.json'].toString());
    if (info.version !== manifest.version) throw Error('Runtime build-info version mismatch');
  }
  if (manifest.background?.service_worker) resource(files, manifest.background.service_worker);
  if (manifest.side_panel?.default_path) resource(files, manifest.side_panel.default_path);
  if (manifest.action?.default_popup) resource(files, manifest.action.default_popup);
  if (manifest.options_page) resource(files, manifest.options_page);
  if (manifest.options_ui?.page) resource(files, manifest.options_ui.page);
  for (const name of Object.values(manifest.icons || {})) resource(files, name);
  const actionIcons = manifest.action?.default_icon;
  for (const name of typeof actionIcons === 'string' ? [actionIcons] : Object.values(actionIcons || {})) resource(files, name);
  for (const script of manifest.content_scripts || [])
    for (const name of [...(script.js || []), ...(script.css || [])]) resource(files, name);
  for (const group of manifest.web_accessible_resources || []) {
    for (const reference of group.resources || []) {
      if (!reference.includes('*')) resource(files, reference);
      else {
        const expression = new RegExp('^' + reference.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        if (!Object.keys(files).some(name => expression.test(name))) throw Error(`Incomplete runtime: unmatched resource ${reference}`);
      }
    }
  }
  for (const [name, bytes] of Object.entries(files)) {
    if (name === INTEGRITY_FILE) continue;
    const text = /\.(?:html|m?js|css)$/.test(name) ? bytes.toString() : '';
    if (name.endsWith('.html')) {
      if (!/<script\b[^>]*\bsrc\s*=/i.test(text)) throw Error(`Incomplete runtime: no script entry in ${name}`);
      for (const match of text.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) resource(files, match[1], name);
    } else if (/\.m?js$/.test(name)) {
      // Vite emits side-effect imports, named imports/re-exports, and literal
      // dynamic imports. Bare specifiers and computed imports are not inferred.
      const patterns = [
        /\b(?:import|export)\s*(?:[\w*{},$\s]+\s*from\s*)?["']([^"']+)["']/g,
        /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
      ];
      for (const pattern of patterns)
        for (const match of text.matchAll(pattern))
          if (/^\.?\.?\//.test(match[1]) && !match[1].includes('${')) resource(files, match[1], name);
      // Vite's preload table is relative to the extension root, while ordinary
      // imports above are relative to their module.
      for (const match of text.matchAll(/["'`]((?:chunks|assets)\/[^"'`\s]+\.(?:m?js|css))["'`]/g)) resource(files, match[1]);
      for (const match of text.matchAll(/\bgetURL\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g))
        if (!match[1].includes('${')) resource(files, match[1], 'manifest.json', true);
    } else if (name.endsWith('.css')) {
      for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g))
        if (!/^(?:data:|https?:|#)/i.test(decodeURIComponent(match[1]))) resource(files, match[1], name);
    }
  }
  return manifest;
}

export function createRuntimeIntegrity(files) {
  const contents = payload(files);
  validateStructure(contents);
  const hashes = Object.fromEntries(Object.keys(contents).sort().map(name => [name, hash(contents[name])]));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, files: hashes }, null, 2) + '\n');
}

/** New inputs require a seal. Existing legacy installs may lack it, but still
 * need valid entry points/references; a present seal is never silently ignored.
 */
export function validateRuntimeIntegrity(files, { requireIntegrity = true } = {}) {
  const sealed = own(files, INTEGRITY_FILE);
  const manifest = validateStructure(files, { legacy: !requireIntegrity && !sealed });
  if (!sealed) {
    if (requireIntegrity) throw Error('Missing runtime-integrity.json; run npm run build before installing or packaging');
    return manifest;
  }
  let seal;
  try { seal = JSON.parse(files[INTEGRITY_FILE].toString()); }
  catch { throw Error('Invalid runtime integrity manifest JSON'); }
  if (seal?.schemaVersion !== 1 || !seal.files || typeof seal.files !== 'object' || Array.isArray(seal.files)) throw Error('Invalid runtime integrity manifest schema');
  const contents = payload(files);
  for (const [name, expected] of Object.entries(seal.files)) {
    if (!safePath(name) || name === INTEGRITY_FILE || typeof expected !== 'string' || !/^[a-f\d]{64}$/.test(expected)) throw Error(`Invalid runtime integrity entry: ${name}`);
    if (!own(contents, name)) throw Error(`Runtime integrity mismatch: missing ${name}`);
    if (hash(contents[name]) !== expected) throw Error(`Runtime integrity mismatch: modified ${name}`);
  }
  for (const name of Object.keys(contents))
    if (!own(seal.files, name)) throw Error(`Runtime integrity mismatch: unexpected file ${name}`);
  return manifest;
}
