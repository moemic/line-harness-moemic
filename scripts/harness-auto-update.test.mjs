import assert from 'node:assert/strict';
import { targets, validateDatabase, compareReleaseTags, preserveConfig, migrationNames, assertPreservedSettings, assertAdditiveStatement, publicHealth, checkRecordDue, assertActiveUpload } from './harness-auto-update.mjs';

for (const target of Object.values(targets)) {
  validateDatabase({ bindings: [{ type: 'd1', name: 'DB', id: target.database }] }, target);
  assert.throws(() => validateDatabase({ bindings: [{ type: 'd1', name: 'DB', id: '別のデータベース' }] }, target));
  assert.throws(() => validateDatabase({ bindings: [] }, target));
}
assert.equal(compareReleaseTags('v0.24.10', 'v0.24.9'), 1);
assert.equal(compareReleaseTags('v1.0.0', 'v0.99.99'), 1);
assert.equal(compareReleaseTags('v0.5.1', 'v0.5.1'), 0);
assert.equal(compareReleaseTags('v0.5.0', 'v0.5.1'), -1);
for (const tag of ['v1.0.0-beta', '../main', 'v01.0.0']) assert.throws(() => compareReleaseTags(tag, 'v1.0.0'));
assert.deepEqual(migrationNames('A\tpackages/db/migrations/100_add.sql\n'), ['100_add.sql']);
for (const change of ['M\tpackages/db/migrations/100_add.sql', 'D\tpackages/db/migrations/100_add.sql', 'A\t../bad.sql']) assert.throws(() => migrationNames(change));

const settings = { bindings: [{ type: 'd1', name: 'DB', id: targets.line.database }, { type: 'plain_text', name: 'ADMIN_ORIGIN', text: 'https://existing.example' }, { type: 'secret_text', name: 'API_KEY' }, { type: 'assets', name: 'ASSETS' }], compatibility_flags: ['nodejs_compat'] };
const config = { assets: { binding: 'ASSETS', directory: './client' }, vars: { ADMIN_ORIGIN: 'placeholder' }, d1_databases: [{ database_id: 'placeholder' }], durable_objects: { bindings: [{ name: 'TENANT_SCHEDULER' }] }, migrations: [{ tag: 'v1' }] };
const result = preserveConfig(config, settings, targets.line, 'account', ['*/5 * * * *']);
assert.equal(result.d1_databases[0].database_id, targets.line.database);
assert.equal(result.vars.ADMIN_ORIGIN, 'https://existing.example');
assert.equal(result.vars.API_KEY, undefined);
assert.equal(result.keep_vars, true);
assert.equal(result.durable_objects, undefined);
assert.deepEqual(result.compatibility_flags, ['nodejs_compat']);
assert.equal(config.vars.ADMIN_ORIGIN, 'placeholder');
assert.throws(() => preserveConfig({ ...config, assets: undefined }, settings, targets.line, 'account', []));
assert.throws(() => preserveConfig({ ...config, r2_buckets: [{ binding: 'NEW_STORAGE' }] }, settings, targets.line, 'account', []));
assert.throws(() => preserveConfig(config, { ...settings, bindings: [...settings.bindings, { type: 'queue', name: 'NEW' }] }, targets.line, 'account', []));
assertPreservedSettings(settings, structuredClone(settings), targets.line);
assert.throws(() => assertPreservedSettings(settings, { ...settings, bindings: settings.bindings.filter(b => b.type !== 'secret_text') }, targets.line));
assert.throws(() => assertPreservedSettings(settings, { ...settings, compatibility_flags: [] }, targets.line));
console.log('安定版・D1・既存設定・migration保護のチェック成功');

for (const sql of ['CREATE TABLE IF NOT EXISTS items (id TEXT)', 'CREATE UNIQUE INDEX idx ON items(id)', 'ALTER TABLE items ADD COLUMN label TEXT']) assertAdditiveStatement(sql);
for (const sql of ['DELETE FROM items', 'UPDATE items SET id = 1', 'INSERT OR REPLACE INTO items VALUES (1)', 'ALTER TABLE items DROP COLUMN label', 'ALTER TABLE items RENAME TO old', 'CREATE TRIGGER x AFTER INSERT ON items BEGIN DELETE FROM items; END']) assert.throws(() => assertAdditiveStatement(sql));

const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).endsWith('/admin/version') ? { version: '0.24.1' } : { data: { status: 'ok' } }), { status: 200 });
  await publicHealth(targets.line, '0.24.1');
  await publicHealth(targets.x, '0.5.1');
  globalThis.fetch = async () => new Response('', { status: 401 });
  await publicHealth(targets.line);
} finally { globalThis.fetch = realFetch; }

const checkTime = Date.parse('2026-10-12T12:00:00Z');
assert.equal(checkRecordDue(null, checkTime), true);
assert.equal(checkRecordDue({ checkedAt: '2026-09-12T12:00:00Z' }, checkTime), true);
assert.equal(checkRecordDue({ checkedAt: '2026-09-13T12:00:00Z' }, checkTime), false);
assert.throws(() => checkRecordDue({ checkedAt: '壊れた日時' }, checkTime));

const activeUpload = { versions: [{ version_id: 'current' }] };
assertActiveUpload(activeUpload, { items: [{ id: 'older', number: 1 }, { id: 'current', number: 2 }] });
assert.throws(() => assertActiveUpload(activeUpload, { items: [{ id: 'unpublished', number: 3 }, { id: 'current', number: 2 }] }));
assert.throws(() => assertActiveUpload(activeUpload, { items: [] }));
