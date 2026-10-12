import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const targets = {
  line: { repository: 'Shudesu/line-harness-oss', worker: 'line-harness', url: 'https://line-harness.main-d59.workers.dev', database: 'feebed29-207d-418e-a8a4-d05375fdca67', databaseName: 'line-crm', admin: 'https://web-three-kappa-96.vercel.app' },
  x: { repository: 'Shudesu/x-harness-oss', worker: 'x-harness-worker', url: 'https://x-harness-worker.main-d59.workers.dev', database: '55c1d3b8-a47e-41b6-a4f8-fed1654031f8', databaseName: 'x-harness', admin: 'https://x-harness-web-ar8.pages.dev', pages: 'x-harness-web' },
};

export function validateDatabase(settings, target) {
  const bindings = settings.bindings.filter(binding => binding.type === 'd1');
  if (bindings.length !== 1 || bindings[0].name !== 'DB' || (bindings[0].id ?? bindings[0].database_id) !== target.database) throw new Error(`${target.worker}: 既存D1と設定が一致しません`);
}

export function compareReleaseTags(left, right) {
  const parse = tag => {
    const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
    if (!match) throw new Error('安定版のリリースタグが必要です');
    return match.slice(1).map(BigInt);
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function preserveConfig(config, settings, target, account, crons) {
  validateDatabase(settings, target);
  const supported = new Set(['d1', 'r2_bucket', 'kv_namespace', 'plain_text', 'secret_text', 'secret_key', 'assets']);
  for (const binding of settings.bindings) if (!supported.has(binding.type)) throw new Error(`未対応の既存binding: ${binding.type}`);
  const result = structuredClone(config);
  const installedNames = new Set(settings.bindings.map(binding => binding.name));
  const optionalExisting = target.worker === 'line-harness' ? new Set(['IMAGES', 'TENANT_SCHEDULER']) : new Set();
  for (const binding of [...(config.r2_buckets ?? []), ...(config.kv_namespaces ?? []), ...(config.durable_objects?.bindings ?? [])]) {
    const name = binding.binding ?? binding.name;
    if (!installedNames.has(name) && !optionalExisting.has(name)) throw new Error(`新規binding ${name} の配置確認が必要です`);
  }
  for (const name of ['services', 'vectorize', 'hyperdrive', 'workflows', 'pipelines', 'dispatch_namespaces', 'analytics_engine_datasets']) {
    if (config[name]?.length) throw new Error(`新規の配置構成 ${name} を確認してください`);
  }
  if (config.queues?.producers?.length || config.queues?.consumers?.length) throw new Error('Queuesの配置確認が必要です');
  result.name = target.worker;
  result.account_id = account;
  result.keep_vars = true;
  result.vars = Object.fromEntries(settings.bindings.filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
  result.d1_databases = [{ binding: 'DB', database_id: target.database, database_name: target.databaseName }];
  result.r2_buckets = settings.bindings.filter(b => b.type === 'r2_bucket').map(b => ({ binding: b.name, bucket_name: b.bucket_name }));
  result.kv_namespaces = settings.bindings.filter(b => b.type === 'kv_namespace').map(b => ({ binding: b.name, id: b.namespace_id }));
  result.compatibility_flags = [...new Set([...(settings.compatibility_flags ?? []), ...(result.compatibility_flags ?? [])])];
  result.triggers = { crons };
  if (settings.bindings.some(b => b.type === 'assets') && !result.assets) throw new Error('既存Worker Assetsを失う更新は実行できません');
  // 既存の配置構成を保持する。新規bindingが必要な版は設定を確認してから導入する。
  delete result.durable_objects;
  delete result.migrations;
  delete result.cache;
  return result;
}

export function migrationNames(changes) {
  return changes.trim().split('\n').filter(Boolean).map(line => {
    const [status, path] = line.split('\t');
    if (status !== 'A' || !/^packages\/db\/migrations\/[\w.-]+\.sql$/.test(path)) throw new Error('既存migrationの変更・削除は自動適用しません');
    return basename(path);
  });
}

export function assertActiveUpload(active, versions) {
  const latest = versions.items?.reduce((a, b) => a && a.number > b.number ? a : b, null);
  if (!latest || latest.id !== active.versions[0].version_id) throw new Error('最新アップロードと稼働Versionが異なるため配置を確認してください');
}

export function checkRecordDue(record, now) {
  if (!record) return true;
  const checkedAt = Date.parse(record.checkedAt);
  if (!Number.isFinite(checkedAt)) throw new Error('最終確認記録の日時が不正です');
  return now - checkedAt >= 30 * 86400000;
}

export function assertAdditiveStatement(statement) {
  if (!/^\s*(?:CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\b|ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+ADD\s+)/i.test(statement)) throw new Error('追加DDL以外のSQLは確認してから適用します');
}

export function assertPreservedSettings(before, after, target) {
  validateDatabase(after, target);
  const fingerprint = settings => JSON.stringify(settings.bindings.map(binding => ({ name: binding.name, type: binding.type, id: binding.id ?? binding.database_id, bucket: binding.bucket_name, namespace: binding.namespace_id, text: binding.text })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (fingerprint(before) !== fingerprint(after)) throw new Error('更新後のbinding・設定・Secret名が既存構成と一致しません');
  for (const flag of before.compatibility_flags ?? []) if (!after.compatibility_flags?.includes(flag)) throw new Error('既存のcompatibility flagが失われました');
}

// LINE v0.24.2 は保存済みデータが旧 Worker と非互換になり得る。
// 公開結果が不明な場合も旧版へ戻さず、新版とデータを保全する。
export async function recoverUpdateFailure(name, error, rollback) {
  if (name === 'line') {
    throw new Error(`LINE 更新未完了。旧 Worker 単独 rollback は禁止です。稼働版・管理画面・main・D1復旧地点を照合し、新版へ復旧してください: ${error.message}`, { cause: error });
  }
  await rollback();
  throw error;
}

const root = process.cwd();
const runtime = resolve(root, '.harness-runtime');
const secretKeys = ['CLOUDFLARE_API_TOKEN', 'GH_TOKEN', 'VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'];
const hash = value => createHash('sha256').update(value).digest('hex');
function command(program, args, cwd = root, authenticated = false, capture = false, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, WRANGLER_SEND_METRICS: 'false' };
  if (!authenticated) for (const key of secretKeys) delete env[key];
  return execFileSync(program, args, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 16 * 1024 * 1024 });
}
const git = (args, cwd = root) => command('git', args, cwd, true, true).trim();
export async function api(url, token, options = {}) {
  let response;
  const endpoint = `${new URL(url).hostname}${new URL(url).pathname}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000), headers: { ...options.headers, Authorization: `Bearer ${token}`, 'User-Agent': 'Harness-Auto-Update' } });
      break;
    } catch (error) {
      // 応答のない読み取りだけを一度再照合し、書き込みを重複実行しない。
      if ((options.method ?? 'GET') !== 'GET' || attempt === 1) throw new Error(`API接続失敗: ${endpoint} (${error.name})`);
      console.log(`API読み取りを一度再照合します: ${endpoint}`);
      await delay(1000);
    }
  }
  if (!response.ok) throw new Error(`API確認失敗: ${endpoint} HTTP ${response.status}`);
  return response;
}

async function json(url, token, options) {
  const data = await (await api(url, token, options)).json();
  if (data.success === false) throw new Error('Cloudflare API確認失敗');
  return data.result ?? data;
}
async function workerHash(url, token) {
  const form = await (await api(url, token)).formData();
  const entries = [];
  for (const [name, value] of form.entries()) {
    if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..')) throw new Error('Worker module名が不正です');
    // shortcut: 現行のJavaScript modulesを照合する。WASM等が追加されたらbinary対応を確認する。
    if (!/\.(m?js)$/.test(name)) throw new Error('未対応のWorker module形式です');
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(await value.arrayBuffer());
    entries.push([name, hash(bytes)]);
  }
  if (!entries.length) throw new Error('Workerのコードが取得できません');
  return hash(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, digest]) => `${name}\0${digest}\n`).join(''));
}
export async function publicHealth(target, expectedVersion) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`${target.url}/api/health`, { signal: AbortSignal.timeout(15000) });
      if (target.worker === 'line-harness' && !expectedVersion && response.status === 401) return;
      if (response.status !== 200 || (await response.json()).data?.status !== 'ok') throw new Error('Workerのhealth確認に失敗しました');
      if (target.worker === 'line-harness' && expectedVersion) {
        const version = await fetch(`${target.url}/admin/version`, { signal: AbortSignal.timeout(15000) });
        if (!version.ok || (await version.json()).version !== expectedVersion) throw new Error('LINE Workerの配置版番号が一致しません');
      }
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      // Cloudflareの配置直後は旧応答が残ることがあるため、反映を待って照合する。
      await delay(5000);
    }
  }
}

async function prepareSource(name, state, release, update) {
  const target = targets[name];
  const source = name === 'line' ? root : mkdtempSync(resolve(runtime, 'x-source-'));
  if (name === 'x') {
    command('git', ['clone', `https://github.com/${target.repository}.git`, source]);
    git(['checkout', '--detach', state.sourceSha], source);
    git(['config', 'user.name', 'github-actions[bot]'], source);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], source);
    git(['apply', '--3way', resolve(root, 'config/harness-updates/x-customizations.patch')], source);
    git(['commit', '-m', 'Preserve installed X Harness customizations'], source);
  }
  let sourceSha = state.sourceSha;
  if (name === 'line' && update) {
    // dry-run の隔離 checkout でも上流 merge に committer が必要。
    git(['config', 'user.name', 'github-actions[bot]'], source);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], source);
  }
  if (update) {
    git(['fetch', '--no-tags', `https://github.com/${target.repository}.git`, `refs/tags/${release.tag_name}`], source);
    sourceSha = git(['rev-parse', 'FETCH_HEAD^{commit}'], source);
    git(['merge-base', '--is-ancestor', state.sourceSha, sourceSha], source);
    git(['merge', '--no-edit', sourceSha], source);
  }
  return { source, sourceSha, names: migrationNames(git(['diff', '--name-status', state.sourceSha, sourceSha, '--', 'packages/db/migrations'], source)), sourcePatch: name === 'x' ? git(['diff', '--binary', sourceSha], source) + '\n' : null };
}

async function build(name, source, settings, account, crons) {
  command('pnpm', ['install', '--frozen-lockfile'], source);
  if (name === 'line') {
    command('pnpm', ['--filter', '@line-crm/shared', '--filter', '@line-crm/line-sdk', '--filter', '@line-crm/db', '--filter', '@line-harness/update-engine', 'build'], source);
    command('pnpm', ['--filter', 'worker', 'typecheck'], source);
    command('pnpm', ['--filter', 'worker', 'test'], source);
    const versionPath = resolve(source, 'apps/worker/src/_version.ts');
    const versionSource = readFileSync(versionPath, 'utf8');
    const packageVersion = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version;
    compareReleaseTags(packageVersion, packageVersion);
    try {
      // ソース版は公式bundleのhashを名乗らず、実際にビルドするバージョンだけを記録する。
      writeFileSync(versionPath, versionSource.replace(/^export const BUNDLE_VERSION = .*;$/m, `export const BUNDLE_VERSION = ${JSON.stringify(packageVersion)};`));
      command('pnpm', ['--filter', 'worker', 'build'], source);
    } finally {
      writeFileSync(versionPath, versionSource);
    }
  } else {
    const typeConfig = resolve(source, 'apps/worker/tsconfig.harness-update.json');
    writeFileSync(typeConfig, JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'] }));
    // 上流のテスト用mockの型エラーを本番コンパイルに混ぜない。テスト自体は次で全件実行する。
    command('pnpm', ['--filter', 'worker', 'exec', 'tsc', '--noEmit', '--project', typeConfig], source);
    command('pnpm', ['test'], source);
  }
  if (name === 'line') {
    // GitHub status が作成されない配布でも、本番 alias の実内容を照合する。
    const marker = { releaseTag: `v${JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8')).version}`, sourceRevision: git(['rev-parse', 'HEAD'], source) };
    writeFileSync(resolve(source, 'apps/web/public/harness-release.json'), JSON.stringify(marker) + '\n');
  }
  command('pnpm', ['--filter', 'web', 'build'], source, false, false, { NEXT_PUBLIC_API_URL: targets[name].url });
  let config, configPath;
  const workerDirectory = resolve(source, 'apps/worker');
  if (name === 'line') {
    configPath = resolve(workerDirectory, 'dist/line_harness/wrangler.json');
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } else {
    configPath = resolve(runtime, 'x-wrangler.json');
    config = JSON.parse(command('python3', ['-c', 'import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', resolve(workerDirectory, 'wrangler.toml')], source, false, true));
    config.main = resolve(workerDirectory, config.main);
  }
  writeFileSync(configPath, JSON.stringify(preserveConfig(config, settings, targets[name], account, crons), null, 2), { mode: 0o600 });
  command('pnpm', ['--filter', 'worker', 'exec', 'wrangler', 'deploy', '--config', configPath, '--dry-run', '--outdir', resolve(runtime, `${name}-build`)], source);
  return configPath;
}

export function adminReleaseMatches(actual, expected) {
  return /^v\d+\.\d+\.\d+$/.test(expected?.releaseTag ?? '') && /^[0-9a-f]{40}$/.test(expected?.sourceRevision ?? '') && actual?.releaseTag === expected.releaseTag && actual?.sourceRevision === expected.sourceRevision;
}

export async function waitForVercel(sha, token, expected, { attempts = 60, pause = delay } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${targets.line.admin}/harness-release.json?revision=${encodeURIComponent(expected.sourceRevision)}`, { signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
      if (response.ok && adminReleaseMatches(await response.json(), expected)) return;
    } catch { /* 配布直後の一時的な通信失敗は次の照合へ進む。 */ }
    const statuses = await json(`https://api.github.com/repos/moemic/line-harness-moemic/commits/${sha}/status`, token);
    const status = statuses.statuses.find(s => /^Vercel$/i.test(s.context));
    if (status?.state === 'failure' || status?.state === 'error') throw new Error('Vercelの管理画面更新に失敗しました');
    // status success だけで終えず、本番 alias の実配布 marker を照合する。
    if (attempt + 1 < attempts) await pause(15000);
  }
  throw new Error('Vercelの管理画面の実配布内容を確認できませんでした');
}

async function run(mode) {
  if (!['check', 'dry-run', 'update'].includes(mode)) throw new Error('実行モードが不正です');
  if (mode === 'update' && process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('本番更新はmain上でのみ実行できます');
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, GH_TOKEN: githubToken } = process.env;
  if (!account || !token || !githubToken) throw new Error('既存のCloudflare／GitHub認証が必要です');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const creds = { accountId: account, apiToken: token };
  mkdirSync(runtime, { recursive: true });
  if (mode === 'update') {
    git(['config', 'user.name', 'github-actions[bot]']);
    git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    // Git連携で解決できる所有者をauthorにし、自動処理はcommitterとして記録する。
    process.env.GIT_AUTHOR_NAME = 'moemic';
    process.env.GIT_AUTHOR_EMAIL = '15962725+moemic@users.noreply.github.com';
  }
  const selected = process.env.HARNESS_TARGET === 'both' || !process.env.HARNESS_TARGET ? Object.keys(targets) : [process.env.HARNESS_TARGET];
  for (const name of selected) {
    const target = targets[name];
    if (!target) throw new Error('対象Harnessが不正です');
    // LINE は Worker・管理画面の安全な復旧手順を検証するまで本番更新を保留する。
    if (name === 'line' && mode === 'update' && !(process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.HARNESS_TARGET === 'line')) {
      console.log('LINE 本番更新は安全修正の検証完了まで保留中です');
      continue;
    }
    const statePath = resolve(root, `config/harness-updates/${name}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const url = `${base}/workers/scripts/${target.worker}`;
    const settings = await json(`${url}/settings`, token);
    validateDatabase(settings, target);
    const deployments = await json(`${url}/deployments`, token);
    const active = deployments.deployments[0];
    if (active.versions.length !== 1 || active.versions[0].percentage !== 100) throw new Error('段階的デプロイ中のWorkerは更新できません');
    assertActiveUpload(active, await json(`${url}/versions`, token));
    const currentHash = await workerHash(url, token);
    if (currentHash !== state.codeHash) throw new Error(`${target.worker}: 登録後にコードが変更されています。既存の修正を確認してください`);
    const release = await json(`https://api.github.com/repos/${target.repository}/releases/latest`, githubToken);
    if (release.prerelease || release.draft) throw new Error('正式な安定版リリースが必要です');
    const newer = compareReleaseTags(release.tag_name, state.releaseTag) > 0;
    if (newer && active.versions[0].version_id !== state.workerVersion) throw new Error('登録後の配置変更を確認してから更新してください');
    await publicHealth(target);
    if (name === 'x') await json(`${base}/pages/projects/${target.pages}`, token);
    console.log(JSON.stringify({ harness: name, registeredRelease: state.releaseTag, latestRelease: release.tag_name, databaseVerified: true, workerCodeVerified: true, newerRelease: newer, mode }));
    if (mode === 'check' || (!newer && mode !== 'dry-run')) continue;
    const schedules = await json(`${url}/schedules`, token);
    const { source, sourceSha, names, sourcePatch } = await prepareSource(name, state, release, newer);
    const configPath = await build(name, source, settings, account, schedules.schedules.map(s => s.cron));
    const engine = await import(pathToFileURL(resolve(root, 'packages/update-engine/dist/index.mjs')).href);
    const migrations = new Map(names.map(file => [file, readFileSync(resolve(source, 'packages/db/migrations', file))]));
    for (const sql of migrations.values()) {
      for (const statement of engine.splitSqlStatements(sql.toString('utf8'))) {
        assertAdditiveStatement(engine.stripSqlComments(statement));
      }
    }
    console.log(JSON.stringify({ harness: name, sourceSha, migrations: names, buildVerified: true, deploymentConfigVerified: true }));
    if (mode === 'dry-run') continue;
    const pagesBefore = name === 'x' ? (await json(`${base}/pages/projects/${target.pages}`, token)).canonical_deployment.id : null;
    const readLineCounts = async () => {
      const result = await json(`${base}/d1/database/${target.database}/query`, token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT (SELECT COUNT(*) FROM friends) AS friends, (SELECT COUNT(*) FROM line_accounts) AS accounts, (SELECT COUNT(*) FROM messages_log) AS messages' }) });
      return result[0].results[0];
    };
    const lineCountsBefore = name === 'line' ? await readLineCounts() : null;
    if (lineCountsBefore) console.log(JSON.stringify({ lineCountsBefore }));
    const bookmark = command('pnpm', ['exec', 'wrangler', 'd1', 'time-travel', 'info', target.databaseName, '--json'], root, true, true);
    console.log(`D1復旧地点: ${bookmark.trim()}`);
    try {
      await engine.applyD1Migrations({ creds, databaseId: target.database, names, migrations });
      command('pnpm', ['--filter', 'worker', 'exec', 'wrangler', 'deploy', '--config', configPath], source, true);
      assertPreservedSettings(settings, await json(`${url}/settings`, token), target);
      await publicHealth(target, release.tag_name.replace(/^v/, ''));
      if (name === 'x') {
        command('pnpm', ['exec', 'wrangler', 'pages', 'deploy', resolve(source, 'apps/web/out'), '--project-name', target.pages, '--branch', 'main', '--commit-hash', sourceSha], root, true);
        writeFileSync(resolve(root, 'config/harness-updates/x-customizations.patch'), sourcePatch);
      } else {
        git(['add', '-A']);
        if (git(['status', '--porcelain'])) git(['commit', '-m', `chore: update LINE Harness to ${release.tag_name}`]);
        git(['push', 'origin', 'HEAD:main']);
        await waitForVercel(git(['rev-parse', 'HEAD']), githubToken, JSON.parse(readFileSync(resolve(root, 'apps/web/public/harness-release.json'), 'utf8')));
      }
      const admin = await fetch(target.admin, { signal: AbortSignal.timeout(15000) });
      if (!admin.ok) throw new Error(`管理画面の応答確認失敗: HTTP ${admin.status}`);
      if (name === 'line') {
        const lineCountsAfter = await readLineCounts();
        console.log(JSON.stringify({ lineCountsBefore, lineCountsAfter }));
        for (const key of ['friends', 'accounts', 'messages']) {
          if (!Number.isInteger(lineCountsAfter[key]) || lineCountsAfter[key] < lineCountsBefore[key]) throw new Error(`LINE D1 件数が減少しています: ${key}`);
        }
      }
      const latest = await json(`${url}/deployments`, token);
      writeFileSync(statePath, JSON.stringify({ releaseTag: release.tag_name, sourceSha, workerVersion: latest.deployments[0].versions[0].version_id, codeHash: await workerHash(url, token) }, null, 2) + '\n');
      git(['add', 'config/harness-updates']);
      git(['commit', '-m', `chore: record verified ${name} Harness ${release.tag_name}`]);
      git(['push', 'origin', 'HEAD:main']);
      console.log(`${name}: ${release.tag_name} の自動更新と応答確認に成功しました`);
    } catch (error) {
      await recoverUpdateFailure(name, error, async () => {
        await engine.deployWorkerVersion({ creds, scriptName: target.worker, versionId: active.versions[0].version_id });
        if (pagesBefore && (await json(`${base}/pages/projects/${target.pages}`, token)).canonical_deployment.id !== pagesBefore) {
          await engine.rollbackPagesDeployment({ creds, projectName: target.pages, deploymentId: pagesBefore });
        }
      });
    }
  }
  if (mode === 'update') {
    const recordPath = resolve(root, 'config/harness-updates/last-check.json');
    const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
    if (checkRecordDue(record, Date.now())) {
      // 公開repoの60日無活動によるschedule停止を防ぐため、正常照合結果を月1回保存する。
      writeFileSync(recordPath, JSON.stringify({ checkedAt: new Date().toISOString(), targets: selected }, null, 2) + '\n');
      git(['add', 'config/harness-updates/last-check.json']);
      git(['commit', '-m', 'chore: record verified Harness release check']);
      git(['push', 'origin', 'HEAD:main']);
      console.log('正常確認の記録を保存しました');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await run(process.argv[2] ?? 'check'); }
  catch (error) {
    let message = error.message;
    for (const key of secretKeys) if (process.env[key]) message = message.replaceAll(process.env[key], '[非表示]');
    console.error(message);
    process.exitCode = 1;
  }
}
