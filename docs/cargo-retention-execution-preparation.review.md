# 定期削除の実行準備をまとめる読取診断

2026-10-17 UTC。開発向けの準備だけで、本番/検証の接続、ジョブ登録、有効化、cleanup呼出し、実データ削除は行わない。既存のSupabase PostgreSQL・Cronを将来の候補にし、新しい有料サービスや契約は追加しない。

## 今回追加した範囲

`scripts/check-cargo-retention-execution-preparation.cjs` は、既存の次の3つの匿名JSONをまとめて確認する。SELECT、分類器、cleanup、無効な登録計画は変更しない。

- `inventory`: `integrations/cargo-retention-job-guard/inventory.readonly.sql` の結果。
- `preview`: `integrations/cargo-production-maintenance/retention-preview.readonly.sql` の結果。
- `monitor`: `integrations/cargo-customer-intake/production-monitor.readonly.sql` の結果。

入力の外側は `schema_version:1`、`scope:"cargo-retention-execution-preparation-input"` とし、上記3キーに加工していない結果オブジェクトを入れる。`node scripts/check-cargo-retention-execution-preparation.cjs < review-bundle.json` で読む。秘密値、顧客本文、顧客ID、任意エラー本文を入力へ追加しない。出力は固定コードと真偽値だけで、元の時刻・件数・任意追加値を転載しない。

既存分類器を呼び、鮮度・ジョブの可視性と重複・100件上限・受付/メール停止・権限保護の判断を再利用する。新たに、プレビューとinventoryの関連/稼働/別DBジョブ件数、プレビュー対象が監視の全件数を超えていないこと、アプリ削除履歴件数の一致を確認する。不一致や未確認は、そのまま人による確認へ残す。大小文字だけ違うジョブを旧プレビューが拾わず新inventoryが拾う場合も、不一致として止め、どちらかを都合よく採用しない。

既存monitorはジョブ導入済みを期待し、既存previewは関連ジョブがあればレビューを求める。それぞれ異なる段階の診断である。登録前にmonitorの「ジョブ未導入」が出ても消さず、既存ジョブがある場合もpreviewの警告を消さない。3者を単純な成功条件にまとめたり、登録許可へ変換したりしない。

`preparation_complete`、`registration_allowed`、`execution_enabled`、`sql_generation_allowed` は常にfalse。CLIは常に非0で終了する。SQL生成・接続・ジョブ登録/上書き・有効化・削除の機能を持たない。既存の `plan.disabled.json` を登録前分類器から参照し、頻度・アプリ履歴/Cron履歴の保存期間はnullのままである。

## 将来の読取収集と今回証明できないこと

実サービスの読取は今回実施しない。将来許可された読取収集では、接続先プロジェクトを権限のある別画面で独立確認し、同一接続の明示的な **REPEATABLE READ・READ ONLY** トランザクション内で3つの既存SELECTを採取する。同じMVCCスナップショットで件数を照合する技術条件であり、実行頻度や削除許可の決定ではない。各SELECTは`statement_timestamp()`を持つため、同じトランザクションでも時刻文字列は一致しない。時刻を書き換えて揃えず、既存分類器の各5分以内の鮮度条件を満たす間に診断する。途中で取得が失敗した場合は空の結果で埋めない。

形式ラベル・一致した件数・新しい時刻は、正しいプロジェクトや同一トランザクションの証明にならない。このツールの `project_identity_verified` と `shared_snapshot_verified` は常にfalse。接続先、cleanupの存在/署名/呼出権限、Cron所有者と権限、間接呼出しや外部実行元は独立レビューが必要である。既存の7表/11関数を期待するmonitorは、将来の安全対策追加SQLを本番候補へ含める際に依存一覧のレビューも必要になる。今回その期待値を変更して正常扱いしない。

## 承認待ちと未実装

採用済みの「契約不成立で明示終了した相談は終了後30日で削除」を維持する。保存保留・継続中・送信中/送達不明の保護と、既存1回100件上限も変更しない。運用ログの保存期間は、この顧客相談30日とは別で未決定。

運営者が判断するのは、実行頻度、アプリ履歴/Cron履歴の保存期間、確認担当、初回実行の対象と停止条件である。実行頻度に応じて30日経過後から実削除まで遅れが生じ、100件を超える滞留は1回で消えない。複数バッチの連続実行や、履歴容量の増加に対する消去処理も承認・設計なしに追加しない。既存monitorの遅延しきい値を将来の頻度へ合わせるレビューも残る。

登録直前の排他と原子的な二重登録防止、ジョブ登録、初回実行、実行元停止の独立検出、Cron履歴の維持/削除、失敗後の再開は未実装。このツールの診断結果から、それらを自動実行してはならない。

## 検証の境界

新規テストは架空の3種類の集計だけを使い、既存分類器との接続と証跡間不一致、既存警告を隠さないこと、常時無効の境界、入力保護を確認する。ローカルで`node tests/cargo-retention-execution-preparation.test.cjs`の新規10件が成功、失敗0。差分の空白検査も成功した。CLIの入力境界と終了コード計算は同じ関数への単体試験であり、子プロセスのCLI試験ではない。既存SQL試験、完了済み本人試験、実サービス接続、実メール・外部通知は行っていない。CI結果は親の統合検証で確認後に追記する。
