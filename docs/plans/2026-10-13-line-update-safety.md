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
