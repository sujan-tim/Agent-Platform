import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the extension uses the same Markdown renderer as the website', () => {
  // The extension cannot load files from the website, so it keeps a copy. Fix a failure with:
  //   cp web/markdown.js extension/markdown.js
  assert.equal(read('extension/markdown.js'), read('web/markdown.js'));
});

test('the extension asks for no website access up front', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.host_permissions, undefined, 'sites are granted one by one, when the person allows them');
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
  assert.equal(manifest.content_scripts, undefined, 'page.js runs only when the side panel asks, on allowed sites');
  for (const file of ['background.js', 'sidepanel.html', 'sidepanel.js', 'sidepanel.css', 'page.js', 'icons/128.png']) {
    assert.ok(existsSync(new URL(`../extension/${file}`, import.meta.url)), file);
  }
});
