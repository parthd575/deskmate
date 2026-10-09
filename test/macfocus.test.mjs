// node --test test/macfocus.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssertions, modeName } from '../companion/macfocus.js';

const on = { data: [{ storeAssertionRecords: [{ assertionDetails: { assertionDetailsModeIdentifier: 'com.apple.focus.work' } }] }] };
const off = { data: [{}] };
const modes = { data: [{ modeConfigurations: { 'com.apple.focus.work': { mode: { name: 'Work' } } } }] };

test('detects an active Focus and its name', () => {
  assert.deepEqual(parseAssertions(on), { on: true, modeId: 'com.apple.focus.work' });
  assert.equal(modeName(modes, 'com.apple.focus.work'), 'Work');
  assert.equal(modeName({ data: [] }, 'com.apple.donotdisturb.mode.default'), 'Do Not Disturb');
});
test('no Focus when there are no assertion records', () => {
  assert.equal(parseAssertions(off).on, false);
  assert.equal(parseAssertions({}).on, false);
});
