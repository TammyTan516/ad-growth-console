// SPDX-License-Identifier: MIT
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/host-adapter.js'), 'utf8');

function host(raw = null, failWrite = false) {
  let value = raw;
  const warning = {textContent: ''};
  const context = {
    document: {getElementById: id => id === 'storage-warning' ? warning : null},
    window: {localStorage: {
      getItem: () => value,
      setItem: (_key, next) => {if (failWrite) throw new Error('quota'); value = next;}
    }}
  };
  vm.runInNewContext(source, context);
  return {adapter: context.window.demoHost, warning, saved: () => value};
}
test('save and restore a complete demo snapshot without retaining a mutable reference', async () => {
  const h = host(), payload = {privateContent: {version: 1, state: {history: [{id: 'DEMO-1'}]}}};
  await h.adapter.setWidgetState(payload);
  payload.privateContent.state.history[0].id = 'changed';
  assert.equal(host(h.saved()).adapter.widgetState.privateContent.state.history[0].id, 'DEMO-1');
  assert.equal(h.adapter.widgetState.privateContent.state.history[0].id, 'DEMO-1');
});
test('malformed or unsupported saved state opens a fresh demo with a visible warning', () => {
  for (const raw of ['not json', '{}', '{"privateContent":{"version":1,"state":[]}}']) {
    const h = host(raw);
    assert.equal(h.adapter.widgetState, undefined);
    assert.ok(h.warning.textContent);
  }
});
test('storage quota failure rejects and preserves the last successfully saved record', async () => {
  const h = host(null, true);
  await assert.rejects(h.adapter.setWidgetState({privateContent: {version: 1, state: {}}}), /quota/);
  assert.equal(h.saved(), null);
  assert.equal(h.adapter.widgetState, undefined);
});
