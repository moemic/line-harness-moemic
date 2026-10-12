import assert from 'node:assert/strict';
import { targets, validateDatabase, compareReleaseTags, preserveConfig, migrationNames, assertPreservedSettings, assertAdditiveStatement, publicHealth, checkRecordDue, assertActiveUpload, api, recoverUpdateFailure, adminReleaseMatches, waitForVercel } from './harness-auto-update.mjs';

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

try {
  let reads = 0;
  globalThis.fetch = async () => { if (++reads === 1) throw new TypeError('通信失敗'); return new Response('{}', { status: 200 }); };
  assert.equal((await api('https://api.example/health', 'test-token')).status, 200);
  assert.equal(reads, 2);
  let writes = 0;
  globalThis.fetch = async () => { writes++; throw new TypeError('通信失敗'); };
  await assert.rejects(() => api('https://api.example/write', 'test-token', { method: 'POST' }));
  assert.equal(writes, 1);
} finally { globalThis.fetch = realFetch; }

// 公開前・公開結果不明・管理画面成功後・記録保存失敗を全て照合する。
for (const stage of ['migration', 'worker deploy uncertain', 'worker health', 'main push uncertain', 'Vercel failure', 'admin HTTP after Vercel success', 'state write', 'state push']) {
  let rollbackCalls = 0;
  const failure = new Error(stage);
  await assert.rejects(() => recoverUpdateFailure('line', failure, async () => { rollbackCalls++; }), error => error.cause === failure && error.message.includes('旧 Worker 単独 rollback は禁止'));
  assert.equal(rollbackCalls, 0, stage);
}
let xRollbackCalls = 0;
const xFailure = new Error('既存X処理');
await assert.rejects(() => recoverUpdateFailure('x', xFailure, async () => { xRollbackCalls++; }), error => error === xFailure);
assert.equal(xRollbackCalls, 1);
console.log('LINE異常系8段階の旧Worker単独rollback禁止・既存X復旧のチェック成功');

const marker = { releaseTag: 'v0.24.2', sourceRevision: '053f00d90bcf6318a83be89e71c8394d433ae4a2' };
assert.equal(adminReleaseMatches(marker, marker), true);
assert.equal(adminReleaseMatches({ ...marker, releaseTag: 'v0.24.1' }, marker), false);
assert.equal(adminReleaseMatches({ ...marker, sourceRevision: 'other' }, marker), false);
try {
  let githubRequests = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith(targets.line.admin)) return new Response(JSON.stringify(marker));
    githubRequests++;
    return new Response(JSON.stringify({ statuses: [] }));
  };
  await waitForVercel('commit', 'test-token', marker, { attempts: 1 });
  assert.equal(githubRequests, 0, '本番実内容が一致すればGitHub status欠落でも完了');
  globalThis.fetch = async url => new Response(JSON.stringify(String(url).startsWith(targets.line.admin) ? { ...marker, sourceRevision: 'old' } : { statuses: [{ context: 'Vercel', state: 'success' }] }));
  await assert.rejects(() => waitForVercel('commit', 'test-token', marker, { attempts: 1 }), /実配布内容/);
} finally { globalThis.fetch = realFetch; }
console.log('Vercel status欠落時の実配布確認・旧管理画面拒否のチェック成功');

assert.equal(adminReleaseMatches({}, {}), false);
assert.equal(adminReleaseMatches(null, marker), false);
