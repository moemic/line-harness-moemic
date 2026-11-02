# LINE単体の安定版追従復旧

本人の2026-11-02更新依頼に基づく。対象はmoemic/line-harness-moemicの既存カスタム更新経路。X本体・連携有効化、新認証/Secret/権限/課金は対象外。

実本番v0.24.3、main d66eac8b。最新正式v0.26.1。前担当はidle、GitHubの進行/待機runなし。元checkout2配置は変更せず、必要ソースだけ隔離取得。Macで依存install/buildはしない。

1. 既知のwebhook引数競合だけを厳密に認識し、AI Bridge引数とgate環境引数を両方保持する。他ファイル/別内容の競合は失敗終了し場所を報告する。
2. 既存workflow内でLINE専用dry-run。上流正式タグ、Worker全テスト・型検査・Worker/管理画面/独立LIFFビルド、配置dry-runを検証。独立LIFFの公開先は未特定のため別サービスへ新規配布しない。
3. migration073は7テーブルと1indexの追加のみ。既存D1からschema定義だけをCIの一時SQLiteへ読み取り、追加DDL後の既存定義不変を確認。SQLエラーは隠さない。新規のステージングD1は作らない。
4. 本番配布直前に既存Cloudflare D1 Time Travelの復旧bookmarkを取得。友だち/アカウント/ログの前後件数とbindings/Secret名/flagsを照合。既存テーブルを削除せず、DB復元を自動実行しない。
5. X共有設定3点が揃っていないことを確認。新しいキー/接続設定を追加しない。新機能は閉じたままLINEだけを更新する。X本体は更新しない。
6. cloud CI成功後、修正だけをmainへ反映して既存workflowのupdate/lineを実行。Worker先行、同じsourceをGit連携Vercelへ配布。実版・公開marker・Git登録・主要件数を読み戻す。

rollback条件: LINEは公開後に旧Worker単独へ自動復帰しない。073は追加のみで更新後データを持つ可能性があるため自動DROPをしない。失敗時は稼働Worker/管理画面/main/登録/Time Travelを照合し、新版へ復旧する。DBの時点復元が必要なら、その後の利用者データを失う影響と対象を確認してから別判断する。

制約: schema-only SQLiteでの移行検証は本番D1の全データ複製検証ではない。LINE実送信・実OAuth・購入は行わない。今回の更新成功と次正式版の自然schedule成功は別に扱う。
