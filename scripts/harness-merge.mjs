// 既知の同位置追加だけを結合する。意味が変わった競合を推測で解消しない。
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
