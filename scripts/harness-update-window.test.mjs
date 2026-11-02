import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineUpdateAllowed, assertLineUpdateWindow, guardedLineWrite } from './harness-update-window.mjs';
const modulePath = fileURLToPath(new URL('./harness-update-window.mjs', import.meta.url));
const cases = [
  ['2026-11-01T20:59:59.999Z', false], // 05:59:59.999 JST, next date
  ['2026-11-01T21:00:00.000Z', true],  // 06:00 JST
  ['2026-11-02T12:59:59.999Z', true],  // 21:59:59.999 JST
  ['2026-11-02T13:00:00.000Z', false], // 22:00 JST
  ['2026-11-02T14:59:59.999Z', false], // 23:59:59.999 JST
  ['2026-11-02T15:00:00.000Z', false], // 00:00 JST, next date
  ['2026-11-02T20:59:59.999Z', false],
  ['2026-11-02T21:00:00.000Z', true],
  ['2026-12-31T21:17:00.000Z', true],  // year/date rollover, scheduled 06:17
];
for (const [time, allowed] of cases) assert.equal(lineUpdateAllowed(time), allowed, time);
assert.throws(() => lineUpdateAllowed('invalid'));
for (const mode of ['check', 'dry-run']) assert.doesNotThrow(() => assertLineUpdateWindow('line', mode, 'read', Date.parse(cases[0][0])));
assert.doesNotThrow(() => assertLineUpdateWindow('x', 'update', 'deploy', Date.parse(cases[0][0])));
const originalNow = Date.now;
try {
  let time = Date.parse('2026-11-02T12:59:59.999Z');
  Date.now = () => time;
  const writes = [];
  const sql = guardedLineWrite('line', 'D1 SQL', async value => { writes.push(value); time += 1; });
  await sql('CREATE TABLE allowed');
  assert.throws(() => sql('INSERT ledger blocked'), /更新保留/);
  for (const stage of ['D1 migration', 'Worker deploy', 'admin source push', 'registration push', 'check record push']) {
    assert.throws(() => guardedLineWrite('line', stage, () => writes.push(stage))(), /更新保留/);
  }
  assert.deepEqual(writes, ['CREATE TABLE allowed']);
  guardedLineWrite('x', 'existing X deploy', () => writes.push('X'))();
  assert.deepEqual(writes, ['CREATE TABLE allowed', 'X']);
} finally { Date.now = originalNow; }
// The same real CLI used by manual deployment must fail closed in any runner TZ.
for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
  for (const [time, allowed] of [cases[0], cases[1], cases[3], cases[5]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `Date.now=()=>${Date.parse(time)};process.argv[1]=${JSON.stringify(modulePath)};await import(${JSON.stringify(new URL('./harness-update-window.mjs', import.meta.url).href)});`], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(result.status, allowed ? 0 : 1, `${tz} ${time}: ${result.stderr}`);
  }
}
// Execute the real updater entrypoint in isolated empty repositories at blackout.
// Fake credentials never leave this process: fetch always throws if reached.
for (const target of ['line', 'both']) {
  const dir = mkdtempSync(join(tmpdir(), 'line-hours-test-'));
  execFileSync('git', ['init', '-q', dir]);
  const script = `Date.now=()=>${Date.parse('2026-11-02T13:00:00Z')};globalThis.fetch=()=>{throw new Error('unexpected network')};const {run}=await import(${JSON.stringify(new URL('./harness-auto-update.mjs', import.meta.url).href)});await run('update');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/heads/main', HARNESS_TARGET: target, GH_TOKEN: 'test-only', CLOUDFLARE_API_TOKEN: 'test-only', CLOUDFLARE_ACCOUNT_ID: 'test-only' } });
  if (target === 'line') assert.equal(result.status, 0, result.stderr);
  else { assert.equal(result.status, 1); assert.match(result.stderr, /x\.json/); }
  assert.match(result.stdout, /LINE更新保留/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
}
const auto = readFileSync(new URL('./harness-auto-update.mjs', import.meta.url), 'utf8');
for (const stage of ['D1 migration', 'D1 SQL', 'Worker deploy', 'admin source push', 'registration push', 'check record push']) assert.ok(auto.includes(`'${stage}'`), stage);
assert.ok(auto.indexOf("mode === 'update' && !lineUpdateAllowed()") < auto.indexOf('const settings = await json'));
const scheduled = readFileSync(new URL('../.github/workflows/update-from-upstream.yml', import.meta.url), 'utf8');
assert.match(scheduled, /cron: '17 21 \* \* \*'/);
assert.match(scheduled, /cancel-in-progress: false/);
// Exercise the actual workflow expression for both cron events and manual inputs.
assert.deepEqual([...scheduled.matchAll(/cron: '([^']+)'/g)].map(match => match[1]), ['17 19 * * *', '17 21 * * *']);
const targetExpression = scheduled.match(/HARNESS_TARGET: \$\{\{ (.+) \}\}/)[1];
const selectTarget = new Function('github', 'inputs', `return (${targetExpression});`);
const selectionCases = [
  ['schedule', '17 19 * * *', undefined, 'x'],
  ['schedule', '17 21 * * *', undefined, 'line'],
  ['schedule', 'unexpected', undefined, 'invalid'],
  ['schedule', '17 19 * * *', 'line', 'x'],
  ['schedule', '17 21 * * *', 'x', 'line'],
  ['workflow_dispatch', undefined, 'both', 'both'],
  ['workflow_dispatch', undefined, 'line', 'line'],
  ['workflow_dispatch', undefined, 'x', 'x'],
  ['workflow_dispatch', '17 19 * * *', 'both', 'both'],
  ['workflow_dispatch', undefined, undefined, 'both'],
];
for (const [eventName, schedule, harness, expected] of selectionCases) {
  assert.equal(selectTarget({ event_name: eventName, event: { schedule } }, { harness }), expected);
}
assert.match(scheduled, /group: harness-automatic-update/);
assert.match(scheduled, /UPDATE_MODE: \$\{\{ github.event_name == 'schedule' && 'update' \|\| inputs.mode \}\}/);
console.log('schedule分離10ケース成功: X04:17 JST / LINE06:17 JST、未知schedule拒否、手動both/line/x保持');

assert.match(scheduled, /inputs.harness \|\| 'both'/);
const manual = readFileSync(new URL('../.github/workflows/deploy-cloudflare-worker.yml', import.meta.url), 'utf8');
assert.match(manual, /set -euo pipefail\n\s+node scripts\/harness-update-window.mjs/);
for (const line of manual.split('\n').map((s,i,a)=>({s,i,a})).filter(({s})=>/^\s+npx wrangler d1 execute/.test(s))) {
  assert.match(line.a[line.i - 1], /node scripts\/harness-update-window.mjs/);
}
assert.match(manual, /preCommands: node ..\/..\/scripts\/harness-update-window.mjs/);
assert.match(manual, /cancel-in-progress: false/);
// Run the actual manual migration shell with fake wrangler and an expiring guard.
const migrationShell = manual.split('      - name: Run pending D1 migrations')[1].split('        run: |\n')[1].split('\n      - name:')[0].split('\n').map(line => line.slice(10)).join('\n');
for (const blockOn of [1, 2, 3, 4]) {
  const dir = mkdtempSync(join(tmpdir(), 'line-manual-hours-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'packages/db/migrations'), { recursive: true });
  writeFileSync(join(dir, 'packages/db/migrations/001_fixture.sql'), 'CREATE TABLE fixture(id TEXT);');
  writeFileSync(join(dir, 'bin/node'), `#!/bin/sh
if [ "$1" = "scripts/harness-update-window.mjs" ]; then
 n=0; [ ! -f "$COUNTER" ] || n=$(cat "$COUNTER"); n=$((n+1)); echo "$n" > "$COUNTER"; [ "$n" -lt "$BLOCK_ON" ]; exit $?
fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o700 });
  writeFileSync(join(dir, 'bin/npx'), `#!/bin/sh
case "$*" in *SELECT*) echo '[{"results":[]}]';; *) echo "$*" >> "$WRITES";; esac
`, { mode: 0o700 });
  const result = spawnSync('bash', ['-c', migrationShell], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH, COUNTER: join(dir, 'counter'), WRITES: join(dir, 'writes'), BLOCK_ON: String(blockOn), CLOUDFLARE_API_TOKEN: 'fake', CLOUDFLARE_ACCOUNT_ID: 'fake', D1_DATABASE_NAME: 'fixture' } });
  assert.equal(result.status, 1, result.stderr);
  let writes = []; try { writes = readFileSync(join(dir, 'writes'), 'utf8').trim().split('\n'); } catch {}
  assert.equal(writes.length, Math.max(0, blockOn - 2), `manual block #${blockOn}`);
}
// Verify only the dedicated settings subject suppresses Vercel builds.
const skip = JSON.parse(readFileSync(new URL('../apps/web/vercel.json', import.meta.url), 'utf8')).ignoreCommand;
for (const [subject, expected] of [['chore: protect LINE update hours [line-settings-only]', 0], ['chore: update LINE Harness to v0.26.2', 1]]) {
 const dir = mkdtempSync(join(tmpdir(), 'line-skip-build-'));
 execFileSync('git', ['init', '-q', dir]);
 execFileSync('git', ['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','baseline'], {cwd:dir});
 writeFileSync(join(dir, 'app.js'), 'application change');
 execFileSync('git', ['add', 'app.js'], {cwd:dir});
 execFileSync('git', ['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm',subject], {cwd:dir});
 assert.equal(spawnSync('sh', ['-c', skip], {cwd:dir}).status, expected);
 mkdirSync(join(dir,'config/harness-updates'), {recursive:true});
 writeFileSync(join(dir,'config/harness-updates/x.json'), '{}');
 execFileSync('git',['add','config'],{cwd:dir});
 execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-qm','chore: record verified x Harness'],{cwd:dir});
 assert.equal(spawnSync('sh',['-c',skip],{cwd:dir}).status,0,'registration-only push must not redeploy LINE admin');
}

console.log('更新時間帯: 9境界、invalid、check/dry-run/X、SQL途中到達、5公開境界、CLI 12 TZ/時刻組、workflow接続の検証成功');
