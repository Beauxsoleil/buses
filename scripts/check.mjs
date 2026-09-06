#!/usr/bin/env node
// Static consistency checks that need no browser and no network:
//   * every JS file parses
//   * every named import from a sibling module exists
//   * every HTML page references files that exist (css/js/vendor/fonts)
//   * HTML has no inline scripts, no literal "\u2026" escapes, and a CSP
//   * vendored libraries match the pinned versions recorded in vendor/
//   npm run check
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const note = (msg) => problems.push(msg);

const walk = (dir, ext) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
  const rel = join(dir, entry.name);
  if (entry.isDirectory()) return ['node_modules', '.git', 'vendor'].includes(entry.name) ? [] : walk(rel, ext);
  return rel.endsWith(ext) ? [rel] : [];
});

// 1. Syntax
const jsFiles = [...walk('js', '.js'), ...walk('scripts', '.mjs'), ...walk('tests', '.js'), ...walk('tests', '.mjs')];
for (const file of jsFiles) {
  try { execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' }); } catch (error) { note(`${file}: ${error.stderr.toString().trim().split('\n').slice(-1)[0]}`); }
}

// 2. Imports resolve to real exports
const exportsOf = (file) => {
  const src = readFileSync(join(root, file), 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export \{([^}]*)\}/gm)) m[1].split(',').forEach((n) => names.add(n.trim().split(/\s+as\s+/).pop()));
  return names;
};
for (const file of walk('js', '.js')) {
  const src = readFileSync(join(root, file), 'utf8');
  for (const m of src.matchAll(/import \{([^}]*)\} from '([^']+)'/g)) {
    const target = join(dirname(file), m[2]);
    if (!existsSync(join(root, target))) { note(`${file}: imports missing module ${m[2]}`); continue; }
    const names = exportsOf(target);
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0];
      if (name && !names.has(name)) note(`${file}: '${name}' is not exported by ${m[2]}`);
    }
  }
}

// 3. HTML pages
const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
for (const page of pages) {
  const html = readFileSync(join(root, page), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#?:]+)"/g)) {
    const ref = m[1];
    if (ref.endsWith('.html')) { if (!existsSync(join(root, ref))) note(`${page}: links to missing page ${ref}`); continue; }
    if (!existsSync(join(root, ref))) note(`${page}: references missing file ${ref}`);
  }
  if (/\\u[0-9a-f]{4}/i.test(html)) note(`${page}: contains a literal \\u escape (use the real character)`);
  if (/<script(?![^>]*src=)[^>]*>[^<]*\S[^<]*<\/script>/.test(html)) note(`${page}: has an inline script (blocked by CSP)`);
  if (!html.includes('Content-Security-Policy')) note(`${page}: missing CSP meta tag`);
  if (!html.includes('<div id="chrome">')) note(`${page}: missing #chrome mount for the shared header/nav`);
  if (!html.includes('vendor/supabase.js')) note(`${page}: does not load vendor/supabase.js before the page module`);
  if (html.includes('.js\'') || html.includes('cdn.jsdelivr.net') || html.includes('esm.sh')) note(`${page}: references a CDN; assets are vendored`);
}

// 4. Navigation targets in config exist
const config = readFileSync(join(root, 'js/config.js'), 'utf8');
for (const m of config.matchAll(/href: '([^']+)'/g)) if (!existsSync(join(root, m[1]))) note(`config.js: nav href ${m[1]} does not exist`);

// 5. Vendored bundle integrity (pinned in vendor/VERSIONS)
const versionsFile = join(root, 'vendor/VERSIONS');
if (existsSync(versionsFile)) {
  for (const line of readFileSync(versionsFile, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
    const [file, , hash] = line.trim().split(/\s+/);
    if (!file.endsWith('.js')) continue;
    const path = join(root, 'vendor', file);
    if (!existsSync(path)) { note(`vendor/${file} is missing`); continue; }
    const actual = createHash('sha256').update(readFileSync(path)).digest('base64');
    if (hash && actual !== hash) note(`vendor/${file}: sha256 ${actual} does not match pinned ${hash}`);
  }
} else {
  note('vendor/VERSIONS is missing');
}

// 6. Fonts referenced by CSS exist
const css = readFileSync(join(root, 'css/styles.css'), 'utf8');
for (const m of css.matchAll(/url\(['"]?(\.\.\/[^'")]+)['"]?\)/g)) {
  if (!existsSync(join(root, 'css', m[1]))) note(`styles.css: missing asset ${m[1]}`);
}

if (problems.length) {
  console.error(`check: ${problems.length} problem(s)`);
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  process.exit(1);
}
console.log(`check: ok (${jsFiles.length} scripts, ${pages.length} pages)`);
