import assert from 'node:assert/strict';
import { targets, validateDatabase } from './harness-auto-update.mjs';

for (const target of Object.values(targets)) {
  validateDatabase({ bindings: [{ type: 'd1', name: 'DB', id: target.database }] }, target);
  assert.throws(() => validateDatabase({ bindings: [{ type: 'd1', name: 'DB', id: '別のデータベース' }] }, target));
  assert.throws(() => validateDatabase({ bindings: [] }, target));
}
console.log('既存D1の照合チェック成功');
