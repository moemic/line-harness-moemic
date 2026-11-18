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

export function resolveLineConflicts(source, path) {
  if (path === 'apps/worker/src/routes/webhook.ts') return resolveLineWebhookConflicts(source);
  const additions = {
    '.gitignore': ['.harness-runtime/', '.pnpm-store/\n__pycache__/'],
    'apps/worker/src/routes/webhook.test.ts': ['applyMileageRulesForEvent: vi.fn().mockResolvedValue([]),', 'recordSignatureFailure: vi.fn().mockResolvedValue(undefined),\n  recordSignatureSuccess: vi.fn().mockResolvedValue(undefined),'],
  };
  let count = 0;
  const result = source.replace(/^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n?/gm, (_all, ours, theirs) => {
    if (!additions[path] || ours.trim() !== additions[path][0] || theirs.trim() !== additions[path][1]) throw new Error(`未知のLINE競合です: ${path}`);
    count++;
    return ours + theirs;
  });
  if (count !== 1 || /^(?:<<<<<<<|=======|>>>>>>>)/m.test(result)) throw new Error(`既知のLINE競合と一致しません: ${path}`);
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
    if (!conflicts.length || conflicts.some(path => !['.gitignore', 'apps/worker/src/routes/webhook.test.ts', 'apps/worker/src/routes/webhook.ts'].includes(path))) throw new Error('未知のソース競合です。取り込みを停止します');
  }
  const tree = output.split('\n')[0];
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('マージtreeを確認できません');
  // 全競合を検証してからworktreeへ反映し、未知の内容では保存状態を変えない。
  const resolved = conflicts.map(path => [path, resolveLineConflicts(git(['show', `${tree}:${path}`]) + '\n', path)]);
  git(['read-tree', '--reset', '-u', tree]);
  for (const [path, text] of resolved) {
    writeFileSync(resolve(directory, path), text);
    git(['add', path]);
  }
  // アプリ更新で上流の公開/権限/CI設定を勝手に導入しない。
  git(['restore', `--source=${before}`, '--staged', '--worktree', '--', '.github']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', `chore: merge official LINE source ${incoming}`]);
  console.log('既存CI・AI Bridgeを保持して公式ソースを取り込みました');
}
