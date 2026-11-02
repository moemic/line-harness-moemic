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
