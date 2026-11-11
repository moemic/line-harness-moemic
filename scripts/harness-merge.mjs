import { createHash } from 'node:crypto';

// 既知の同位置追加だけを結合する。意味が変わった競合を推測で解消しない。
export function resolveXConflicts(source, path) {
  let count = 0;
  const result = source.replace(/^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n?/gm, (_all, ours, theirs) => {
    count++;
    if (path === 'apps/worker/src/routes/x-accounts.ts' &&
        ours.trim() === 'hasConsumerKey: !!a.consumer_key,\n    hasConsumerSecret: !!a.consumer_secret,\n    hasAccessTokenSecret: !!a.access_token_secret,' &&
        theirs.trim() === 'needsReauth: !!a.needs_reauth,\n    tokenExpiresAt: a.token_expires_at,') return ours + theirs;
    if (path === 'apps/worker/src/index.ts' &&
        createHash('sha256').update(ours).digest('hex') === 'cea9b2e4f23bd2c3e98f2343d2d320dc6bf3041d1f924a530b3af4945baf3f0f' &&
        createHash('sha256').update(theirs).digest('hex') === '90fe9b31692589d50b53171d1893ef4915752720d127411cfe446223442c3fc0') {
      // 省略URLの補完だけを残し、新版のHTTPS検証・暗号化を保持する。
      return theirs.replace('  let target: URL;', "  if (!/^[a-z][a-z0-9+.-]*:/i.test(body.workerUrl)) body.workerUrl = 'https://' + body.workerUrl;\n  let target: URL;");
    }
    throw new Error(`未知のX競合です: ${path}`);
  });
  if (count !== 1 || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(result)) throw new Error(`既知のX競合と一致しません: ${path}`);
  return result;
}

export async function mergeXRelease(directory, incoming) {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { git(['merge', '--no-edit', incoming]); }
  catch (error) {
    if (error.status !== 1) throw error;
    const paths = git(['diff', '--name-only', '--diff-filter=U']).split('\n');
    const resolved = paths.map(path => [path, resolveXConflicts(readFileSync(resolve(directory, path), 'utf8'), path)]);
    for (const [path, text] of resolved) writeFileSync(resolve(directory, path), text);
    git(['add', ...paths]);
    git(['-c', 'commit.gpgsign=false', 'commit', '--no-edit']);
  }
}

export function resolveLineWebhookConflicts(source) {
  const seen = new Set();
  const pairs = [
    ['c.env.AI_BRIDGE_URL,', 'c.env,'],
    ['aiBridgeUrl?: string,', "gateEnv?: Env['Bindings'],"],
  ];
  const result = source.replace(/^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n?/gm, (_all, ours, theirs) => {
    const index = pairs.findIndex(([a, b]) => ours.trim() === a && theirs.trim() === b);
    if (index < 0 || seen.has(index)) throw new Error('未知のwebhook競合です。自動解消しません');
    seen.add(index);
    return ours + theirs;
  });
  if (seen.size !== 2 || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(result)) throw new Error('既知のwebhook競合2箇所と一致しません');
  return result;
}

// 自前CIを保持し、GitHub Appにworkflow権限を要求しないソース更新を作る。
// 公式baseを明示するため、上流履歴をparentへ追加しなくても次版を三者比較できる。
export async function mergeLineRelease(directory, baseline, incoming) {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['status', '--porcelain'])) throw new Error('未保存のソース変更があります。取り込みを停止します');
  const before = git(['rev-parse', 'HEAD']);
  let output, conflicts = [];
  try {
    output = git(['merge-tree', '--write-tree', `--merge-base=${baseline}`, before, incoming]);
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    output = String(error.stdout).trim();
    conflicts = [...new Set([...output.matchAll(/^\d+ [0-9a-f]+ [123]\t(.+)$/gm)].map(match => match[1]))];
    console.log(JSON.stringify({ mergeConflicts: conflicts }));
    if (conflicts.length !== 1 || conflicts[0] !== 'apps/worker/src/routes/webhook.ts') throw new Error('未知のソース競合です。取り込みを停止します');
  }
  const tree = output.split('\n')[0];
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('マージtreeを確認できません');
  git(['read-tree', '--reset', '-u', tree]);
  if (conflicts.length) {
    const path = resolve(directory, conflicts[0]);
    writeFileSync(path, resolveLineWebhookConflicts(readFileSync(path, 'utf8')));
    git(['add', conflicts[0]]);
  }
  // アプリ更新で上流の公開/権限/CI設定を勝手に導入しない。
  git(['restore', `--source=${before}`, '--staged', '--worktree', '--', '.github']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', `chore: merge official LINE source ${incoming}`]);
  console.log('既存CI・AI Bridgeを保持して公式ソースを取り込みました');
}
