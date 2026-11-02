# LINE update window

本人の明示承認: 毎日06:17 JSTへ変更し、22:00以上〜翌06:00未満はLINE本番更新を禁止する。稼働中サービスを再配布/再起動しない。

- Existing shared cron: `17 21 * * *` UTC = 06:17 JST following calendar day. No duplicate schedule.
- LINE update mode: defer before reads/build at blackout start; check fresh clock before migration entry, each D1 API SQL request, Worker deploy, main source push, registration push, monthly check push. Invalid time fails closed. Read-only check/dry-run and X behavior are retained.
- `both`: initial LINE deferral continues to X. An exception after beginning LINE retains the existing fail-closed whole-run behavior; no old Worker rollback. Shared scheduled X check moves with the existing single event to06:17 JST; no other X workflow is edited.
- Manual Worker workflow uses the same guard on entry, before D1 ledger create, each pending migration file request, each ledger insert, and wrangler-action preCommands immediately before deployment. `set -euo pipefail` propagates failure.
- Submitted in-flight DB/deploy requests are allowed to finish; the guard prevents starting a subsequent request in blackout. No cancellation or rollback is introduced. A migration file request can contain multiple SQL statements; a submitted file is an in-flight operation.
- Settings-only commit exact subject `chore: protect LINE update hours [line-settings-only]` uses Vercel native ignoreCommand (exit0 ignores, exit1 builds). Same minimal config at repo root and apps/web covers the existing monorepo project root. No credentials, domain, security, or running deployment settings change. Future ordinary app commits still build. Registration-only config/harness-updates commits also skip Vercel, preventing X registration/monthly heartbeat pushes from redeploying the shared LINE admin in blackout; X updater logic is unchanged. Reference: https://vercel.com/docs/project-configuration/vercel-json#ignorecommand

Validation before push:
9 time boundaries including year/date rollover; invalid timestamp; check/dry-run/X unaffected; fake-clock expiry between SQL requests and all publication stages; 12 actual CLI executions across UTC/Asia-Tokyo/America-Los-Angeles; real updater start at blackout in isolated line/both fixtures; actual manual migration shell intercepted at four guard boundaries (no real Cloudflare calls); Vercel ignore shell executes0 only for exact settings subject; existing rollback/merge/settings regression suite passes. No local dependency install/build, production migration or redeploy.

After push: read back all changed blobs, inspect GitHub check-only run and Vercel ignored-build result, confirm live alias/Worker unchanged. Future natural cron firing is not yet observed. Do not claim it has been tested.
