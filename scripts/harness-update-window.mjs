import { pathToFileURL } from 'node:url';

// JST has no daylight-saving changes. Use UTC arithmetic, independent of runner TZ.
export function lineUpdateAllowed(now = Date.now()) {
  const time = new Date(now).getTime();
  if (!Number.isFinite(time)) throw new Error('更新時刻を確認できません');
  const hour = new Date(time + 9 * 3600000).getUTCHours();
  return hour >= 6 && hour < 22;
}
export function assertLineUpdateWindow(name = 'line', mode = 'update', stage = 'production write', now = Date.now()) {
  if (name === 'line' && mode === 'update' && !lineUpdateAllowed(now)) {
    throw new Error(`LINE更新保留: 22:00以上〜06:00未満 JST は本番書込み禁止 (${stage})`);
  }
}
// Recheck immediately before each individual asynchronous production operation.
export function guardedLineWrite(name, stage, operation) {
  return (...args) => {
    assertLineUpdateWindow(name, 'update', stage);
    return operation(...args);
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { assertLineUpdateWindow(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
