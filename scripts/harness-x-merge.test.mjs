import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveXConflicts } from './harness-merge.mjs';
for (const [file, path] of [['index.ts', 'apps/worker/src/index.ts'], ['x-accounts.ts', 'apps/worker/src/routes/x-accounts.ts']]) {
  const fixture = readFileSync(new URL(`./fixtures/x-merge/${file}`, import.meta.url), 'utf8');
  const resolved = resolveXConflicts(fixture, path);
  assert.doesNotMatch(resolved, /^(<<<<<<<|=======|>>>>>>>)/m);
  assert.throws(() => resolveXConflicts(fixture, 'unknown.ts'), /未知/);
  assert.throws(() => resolveXConflicts(resolved, path), /一致/);
  if (file === 'index.ts') {
    assert.match(resolved, /target\.protocol !== 'https:'/);
    assert.match(resolved, /await encryptSecret\(body.apiKey, c.env.ENCRYPTION_KEY\)/);
    assert.match(resolved, /body\.workerUrl = 'https:\/\/' \+ body\.workerUrl/);
    assert.match(resolved, /integrationSecret\?: string/);
    assert.throws(() => resolveXConflicts(fixture.replace("target.protocol !== 'https:'", "target.protocol !== 'http:'"), path), /未知/);
  } else {
    for (const field of ['hasConsumerKey', 'hasConsumerSecret', 'hasAccessTokenSecret', 'needsReauth', 'tokenExpiresAt']) assert.ok(resolved.includes(field));
    assert.throws(() => resolveXConflicts(fixture.replace('hasConsumerKey', 'unknown'), path), /未知/);
  }
}
console.log('X既知競合: 既存表示・URL補完、新版HTTPS・暗号化・再認証を保持。未知競合を拒否');

const { preserveConfig, targets, assertPreservedSettings, assertXDataPreserved } = await import('./harness-auto-update.mjs');
const bindings = [{ type: 'd1', name: 'DB', id: targets.x.database }, { type: 'secret_text', name: 'API_KEY' }];
const config = { durable_objects: { bindings: [{ name: 'GATE_CLAIMS', class_name: 'GateClaimCoordinator' }] }, migrations: [{ tag: 'gate-claims-v1', new_sqlite_classes: ['GateClaimCoordinator'] }] };
const built = preserveConfig(config, { bindings }, targets.x, 'account', ['*/5 * * * *']);
assert.deepEqual(built.durable_objects, config.durable_objects);
assert.deepEqual(built.triggers.crons, ['*/5 * * * *']);
assert.throws(() => preserveConfig({ ...config, migrations: [{ tag: 'unknown' }] }, { bindings }, targets.x, 'account', []));
assert.throws(() => preserveConfig({ ...config, durable_objects: { bindings: [{ name: 'UNKNOWN' }] } }, { bindings }, targets.x, 'account', []));
const installed = { type: 'durable_object_namespace', name: 'GATE_CLAIMS', class_name: 'GateClaimCoordinator', namespace_id: 'fixture' };
assertPreservedSettings({ bindings }, { bindings: [...bindings, installed] }, targets.x);
assert.throws(() => assertPreservedSettings({ bindings }, { bindings: [...bindings, { ...installed, class_name: 'unknown' }] }, targets.x));
assert.throws(() => assertPreservedSettings({ bindings }, { bindings: [bindings[0], installed] }, targets.x));
const data = { scheduled_posts: [{ id: 'post', scheduled_at: '2026-11-12 10:00:00', status: 'scheduled' }], x_accounts: [{ id: 'account', access_token: 'synthetic' }] };
const migrated = structuredClone(data);
migrated.scheduled_posts[0].scheduled_at = '2026-11-12T10:00:00+09:00';
assertXDataPreserved(data, migrated);
assert.throws(() => assertXDataPreserved(data, { ...migrated, x_accounts: [] }));
migrated.x_accounts[0].access_token = 'changed';
assert.throws(() => assertXDataPreserved(data, migrated));
migrated.x_accounts[0].access_token = 'synthetic';
migrated.scheduled_posts[0].scheduled_at = '2026-11-12T11:00:00+09:00';
assert.throws(() => assertXDataPreserved(data, migrated));
console.log('既存D1/Secret/cron保持・既知内部構成追加・予約時刻/認証情報保持の回帰試験成功');

const { workerHash, hashWorkerMultipart } = await import('./harness-auto-update.mjs');
const realFetch = globalThis.fetch;
try {
  const form = new FormData();
  form.append('index.js', new Blob(['export default {}']));
  form.append('layout.wasm', new Blob([new Uint8Array([0, 255, 1, 128])]));
  form.append('font.ttf', new Blob([new Uint8Array([255, 0, 128])]));
  globalThis.fetch = async () => new Response(form);
  const first = await workerHash('https://api.example/worker', 'synthetic');
  form.set('layout.wasm', new Blob([new Uint8Array([0, 254, 1, 128])]));
  assert.notEqual(await workerHash('https://api.example/worker', 'synthetic'), first);
  form.append('../unknown.js', new Blob(['unsafe']));
  await assert.rejects(() => workerHash('https://api.example/worker', 'synthetic'), /module名/);
} finally { globalThis.fetch = realFetch; }
console.log('WASM/フォントのバイト照合・変更検出・不正module名拒否の回帰試験成功');

// filenameなしのbinary partもUTF-8文字列へ変換しない。
const raw = Buffer.concat([Buffer.from('--fixture\r\nContent-Disposition: form-data; name="index.wasm"\r\n\r\n'), Buffer.from([0,255,128]), Buffer.from('\r\n--fixture--\r\n')]);
const { createHash } = await import('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
assert.equal(hashWorkerMultipart(raw, 'multipart/form-data; boundary=fixture'), digest(`index.wasm\0${digest(Buffer.from([0,255,128]))}\n`));
assert.throws(() => hashWorkerMultipart(raw, 'multipart/form-data'), /boundary/);
