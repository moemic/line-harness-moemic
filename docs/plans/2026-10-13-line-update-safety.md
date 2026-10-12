# LINE v0.24.2 更新安全修正

承認元: 01a1187a-f0e0-75f5-9184-cd9b294ac014。本人が更新保留・安全修正・検証後の更新を承認済み。

## 対象と手順

1. LINE 本番自動更新のみ保留。main d5493679 に反映し GitHub 読み戻し済み。X の既存更新処理は変更しない。
2. 手動 Worker workflow の既存変数 LINE_HARNESS_CLOUDFLARE_DEPLOY=false を反映・読み戻し済み。実行中の配布は中断しない。
3. LINE の catch は旧 Worker 単独 rollback を行わず、現行配布と保存済みデータを維持して明示的な復旧を要求する。X の既存復旧処理は維持する。
4. 手動 Worker workflow と自動更新の concurrency を共有し cancel-in-progress=false、手動配布は main のみとする。
5. ローカル異常系テスト、LINE 専用 dry-run、CI を確認してから更新保留を解除し LINE 専用 update を実行する。
6. Worker の実版・管理画面・Git 登録・D1 binding と復旧地点を照合する。実ユーザーへの送信やデータ試験書き込みは行わない。

## 復旧の原則

公式 https://github.com/Shudesu/line-harness-oss/releases/tag/v0.24.2 は Worker 先行・管理画面セット更新を要求し、複数メッセージ保存後の旧 Worker 単独戻しを禁止している。追加 migration はない。

Worker 配布の応答が不明、main push の応答が不明、Vercel 失敗、Vercel 成功後の管理画面 HTTP 失敗、状態保存や push の失敗のいずれでも LINE は自動で旧版へ戻さない。現在の Worker deployment ID、main HEAD、Vercel 配布 SHA、D1 復旧地点を照合してから新版の配布・記録を再開する。D1 time-travel を自動実行しない。利用者の更新後データを失う可能性があるため、旧版へ戻す場合はデータ互換性を別途検証する。

## 作業保全と検証

/Users/takahiro/Projects/line-harness-moemic は HEAD 3a84584f、git status --short は空。原 checkout は編集せず、このタスク内の line-safety へ隔離 clone。
他の LINE 自動更新タスクは一覧で idle。GitHub の直近6実行は completed。稼働中の cancel 操作なし。

node scripts/harness-auto-update.test.mjs 成功。8種類の失敗原因で LINE 復旧 handler が rollback callback を呼ばず原因を保持すること、X handler が従来どおり callback を呼ぶことを検証。これは handler の単体試験であり、本番異常の注入試験ではない。

遠隔 LINE dry-run、CI、本番 v0.24.2 配布、管理画面のブラウザ受入と D1 内容照合は後続で確認する。保留解除前には全結果をここへ追記する。


## 本番配布の独立照合（登録確定待ち）

- 本番update: https://github.com/moemic/line-harness-moemic/actions/runs/38295777628 。旧waitForVercelがGitHub status欠落で待機中。稼働中runをcancelせず、新しい並行配布は実行しない。
- dry-run: https://github.com/moemic/line-harness-moemic/actions/runs/38295301434 成功。公式sourceSha053f00d90bcf6318a83be89e71c8394d433ae4a2、migrationなし。
- CI: run38295149600と公式版入りmainのrun38296171165成功。
- Worker: /api/health200ok、/admin/version2000.24.2。最新アップロードと100%稼働Version e46fae5f-11bf-4692-ad4e-36f751c450a8一致。codeHash9136cd551102a594d29ad07f8be7950cd24bf2733e397352b1a148adaf04810d。
- 設定: 既存snapshotとbinding、Secret名、plain-text値、compatibility flags一致。
- D1: 友だち6、アカウント3、メッセージ132。更新前の記録と一致。読み取り復旧地点0000b72c-00000000-00005102-96094ca939440fd6124b3fd36aa5b1eb。復元操作なし。
- Vercel: 本番alias web-three-kappa-96.vercel.appはREADY dpl_J6YxZLuWQ7LsGMwvPSVDG1rVSBMw、Git SHA2a7c4201659e2b3bf39af0adaa9ff5eef73c47fc（v0.24.2を含む）とconnectorで照合。
- ブラウザ: 管理画面ログイン画面の表示成功。ログイン後機能と実LINE送信は未試験。既存StaffAPIは200owner。

## 追加で見つかった待機条件の修正

GitHub commit statusが空でもVercelはREADYで本番aliasへ配布済みだった。statusだけを待つと登録を更新できないため、管理画面のpublic/harness-release.jsonにreleaseTagとソースrevisionを持たせ、本番aliasの実内容で照合する。status successだけで旧画面を合格にしない。status欠落時の成功・旧revisionの拒否の単体試験を追加し成功。手動Workerworkflowにはmigration前とdeploy直前のmain freshness確認を追加。現行run終了後に反映する。


## 公開後失敗の実回帰確認と記録復旧

元update run38295777628は19:27:07 UTC、Vercel GitHub status欠落による確認期限切れでfailure終了。catchは旧Worker単独rollback禁止を明示し、終了後もVersion e46fae5f-11bf-4692-ad4e-36f751c450a8（0.24.2）を維持。D1前後件数は6/3/132で一致。これは公開後の実際の失敗経路であり、失敗run自体を成功とは扱わない。

独立API照合済みの登録候補をline.jsonへ反映する。Worker再配布・DB復元なし。配布確認はVercel本番aliasのmarkerを確認する方式へ修正し、初回markerは実際に配布されたコードrevision2a7c4201を示す。定期LINE保留は、marker読取とcheck成功を確認してから解除する。


## 最終確認と保留解除

登録修復・実配布確認修正commit a87afa868ccb0a11ce01490bbbed49cff4c251b9を反映。LINE check run38297894935成功、最終Core Safety CI run38297899424成功。本番alias/harness-release.jsonはHTTP200、releaseTag v0.24.2・sourceRevision2a7c4201659e2b3bf39af0adaa9ff5eef73c47fcで一致し、waitForVercelの実handlerもGitHub statusなしで成功した。

この確認後に定期LINEupdate除外を削除し、既存手動配布スイッチをtrueへ戻す。旧Worker単独rollback禁止、両workflow排他、手動main freshness確認、D1前後件数確認、実配布marker確認は継続する。元run38295777628はfailureのまま正確に記録し、後続の登録照合check成功と区別する。

残る未確認: ログイン後の管理画面機能、実LINE送信、次の新しい正式版での自然なschedule更新。これらを確認済みとは扱わない。今回のv0.24.2は両側の実配布とD1件数・設定保全を確認済み。
