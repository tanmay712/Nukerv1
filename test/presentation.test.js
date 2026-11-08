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
