const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const publicFile = (name) => readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');

test('interface uses decorative vector icons instead of Unicode pictographs', () => {
  for (const file of ['landing.html', 'auth.html', 'index.html', 'auth.js', 'app.js']) {
    assert.doesNotMatch(publicFile(file), /[\p{Extended_Pictographic}\u2190-\u21ff\u2700-\u27bf]/u, `${file} contains a pictograph or arrow character`);
  }
  for (const file of ['landing.html', 'auth.html', 'index.html']) {
    assert.match(publicFile(file), /<svg class="arrow-icon[^>]*aria-hidden="true"/, `${file} should use decorative SVG arrows`);
  }
});

test('website and dashboard motion respects reduced-motion preferences', () => {
  for (const file of ['website.css', 'style.css']) {
    const css = publicFile(file);
    assert.match(css, /@keyframes\s+[\w-]+/);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  }
});

test('interface palette is neutral apart from provider branding and error messaging', () => {
  const exceptions = new Set(['4285f4', '5865f2', 'fff3ee', 'aa6e57']);
  for (const file of ['website.css', 'style.css']) {
    const css = publicFile(file);
    for (const [, color] of css.matchAll(/#([0-9a-f]{6})(?:[0-9a-f]{2})?\b/gi)) {
      const rgb = color.toLowerCase();
      if (exceptions.has(rgb)) continue;
      assert.equal(rgb.slice(0, 2), rgb.slice(2, 4), `${file}: #${rgb} is not neutral`);
      assert.equal(rgb.slice(2, 4), rgb.slice(4, 6), `${file}: #${rgb} is not neutral`);
    }
  }
  assert.match(publicFile('website.css'), /\.hero-visual img,\.auth-art img\s*\{filter:grayscale\(1\)\}/);
});

test('wallet overview presents unavailable services without fictional balances', () => {
  const html = publicFile('index.html');
  assert.match(html, /class="wallet-value">Unavailable/);
  assert.match(html, /<button class="quick-action" type="button" disabled>/);
  assert.match(html, /<table class="asset-table">/);
  assert.match(html, /Network availability has not been confirmed/);
  assert.match(html, /id="notifications"/);
  assert.doesNotMatch(publicFile('website.js'), /IntersectionObserver/);
});

test('public pages and deployment examples use Cryply branding and domain', () => {
  for (const file of ['landing.html', 'auth.html', 'index.html', 'auth.js', 'app.js']) {
    const text = publicFile(file);
    assert.doesNotMatch(text, /cryptly/i, `${file} still has the old brand`);
    if (file !== 'app.js') assert.match(text, /cryply/i, `${file} should use the Cryply name`);
  }
  for (const file of ['.env.example', 'Caddyfile.example', 'README.md']) {
    const text = readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(text, /cryply\.xyz/);
    assert.doesNotMatch(text, /crypto\.definescloud\.site/);
  }
});

test('owner panel shows the test-only Tatum connection without promising live wallets', () => {
  const html = publicFile('index.html');
  assert.match(html, /id="checkTatum"[^>]*disabled/);
  assert.match(html, /Individual wallets are in development/);
  assert.doesNotMatch(html, /id="loadPrime"/);
  assert.match(publicFile('app.js'), /\/api\/admin\/tatum\/check/);
});
