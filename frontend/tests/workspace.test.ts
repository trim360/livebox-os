import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialWorkspace, moveWidget, metric } from '../src/workspace-state.ts';

test('widget order preserves hidden settings and size without mutating input', () => {
  const original = structuredClone(initialWorkspace.widgets);
  original[0].hidden = true;
  const next = moveWidget(original, 'internet', 'server');
  assert.equal(next[2].id, 'internet');
  assert.equal(next[2].hidden, true);
  assert.equal(original[0].id, 'internet');
  assert.equal(new Set(next.map(w => w.id)).size, 6);
  assert.deepEqual(moveWidget(original, 'internet', 'internet'), original);
});

test('missing metrics are never represented as zero', () => {
  assert.equal(metric(undefined), 'Non disponible');
  assert.equal(metric(null), 'Non disponible');
  assert.equal(metric(NaN), 'Non disponible');
  assert.equal(metric(0, ' %'), '0 %');
});
