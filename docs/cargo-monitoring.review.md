# 軽貨物受付の運用確認（検証環境）

更新：2026-10-16。検証環境では5分ごとに自動検査し、最新状態を記録する。外部通知・本番監視は未導入。

## できること

`integrations/cargo-customer-intake/staging-monitor.readonly.sql` は検証プロジェクト `hvdoqcrnztqmbzgwrovd` の状態をSELECTだけで取得する。出力は件数、制御フラグ、指定した定期処理の最終成功/失敗時刻のみ。申込者、住所、認証コード、暗号化内容、HMAC、回答リンク秘密値、プロバイダーのエラー本文は取得しない。

`scripts/check-cargo-monitor.cjs` はこのJSONを標準入力から受け取り、異常時は終了コード1、不正なJSONは2、問題が見つからなければ0で終了する。通信やDB接続、修復、メール送信、再送、データ削除は行わない。

SQLを実行できる権限が必要。匿名/通常ログイン利用者へテーブル権限を追加しない。scopeは出力形式の識別ラベルであり、接続プロジェクトの証明ではない。実行前に検証プロジェクトの選択を確認する。本番用のジョブ名・しきい値は別途レビューする。

## 検出条件と対応

| 検出する状態 | 判定・初動 |
|---|---|
| 見積もりの送信結果不明 | `QUOTE_DELIVERY_UNKNOWN`。保存状態と配信側を担当者が照合。再送・枠リセットはしない |
| 送信中のまま10分超、または送信開始時刻が欠落 | `QUOTE_SEND_STALLED`。処理中断の可能性を確認。自動で未送信へ戻さない |
| 下書き削除期限を15分超過 | `DRAFT_CLEANUP_BACKLOG`。5分間隔ジョブの履歴、実行上限100件、滞留件数を確認 |
| 期限を2分超過した試験が有効 | `TRIAL_EXPIRY_STALLED`。終了ジョブを確認。顧客APIの30分期限ガードとは別の停止確認 |
| 内部受付ONで有効な本人試験が1件でない | `INTAKE_ON_WITHOUT_SINGLE_ACTIVE_TRIAL`。意図しない制御状態として確認 |
| CAPTCHA/メール確認が無効、設定欠落、不正な型 | 検査失敗。正常とみなして受付を開けない |
| 指定ジョブがない/停止/予定変更 | `*_CONFIG`。既存ジョブを確認し、無断で別ジョブを作り直さない |
| 最終成功がない/古い | `*_STALE`。下書き20分、終了案件90分、本人試験終了5分を上限とする |
| 最終成功より後に失敗 | `*_FAILED`。その後の成功を確認するまで要対応。失敗の本文はこのレポートへ出さない |
| スナップショットが5分より古い/不正 | `STALE_OR_INVALID_SNAPSHOT`。新しい読取結果で確認。古い正常結果を再利用しない |

正常判定は、メール到着や暗号化の正しさ、外部サービス稼働、IP制御、バックアップ、全データの削除完了を保証しない。申込受付の一般公開を承認するものでもない。

## 手動確認の流れ

1. 検証プロジェクトのSQL画面で上記SELECTを実行し、`cargo_monitor_snapshot`のJSONオブジェクトを取得する。SQL失敗・権限不足・テーブル欠落は「未確認」と扱う。
2. 手元の安全な環境で `node scripts/check-cargo-monitor.cjs < snapshot.json` を実行する。配列やSQLの列名を含む外側のラッパーではなく、JSONオブジェクトそのものを渡す。
3. 異常コードに対応する履歴を権限のある画面で確認。送信の再実行、枠の復活、削除、受付再開を自動で行わない。
4. 原因解消後に新しい読取で確認し、時刻と非個人情報の結果だけを記録する。

接続情報をコマンド行・チャット・Gitへ貼らない。JSON入力が不正でも入力本文をエラー出力しない。

## 今回の確認

- 2026-10-16 19:35 JST、検証環境でSELECT実行成功。送信結果不明0、送信停滞0、削除期限超過0、停止漏れ試験0、有効試験0、内部受付OFF。
- 対象の3ジョブは稼働中で、予定一致。下書きと試験終了は19:35、終了案件削除は19:17に成功。失敗記録なし。
- この検査を定期実行する監視サービス・通知先・認証情報管理は未設定。本番導入前に監視間隔、通知先、障害時担当、ジョブ履歴の保管方針を確定する。
- 参照：Supabase Cron Quickstartのジョブ履歴仕様 https://supabase.com/docs/guides/cron/quickstart （2026-10-16確認）。

## 自動検査の結果

- head `b435b1816396e12fcde0e1b324ececf29cbbf43f`：security/SQL run `38888866878`、browser run `38888866882`、staging OFF smoke run `38888866889` はすべて成功。
- ローカル分類試験5件と、隔離PostgreSQLでの正常・送信不明・送信停滞・ジョブ欠落・遅延・失敗・復旧の7ケースを確認。過去の別テストが残した送信不明の架空行は、監視テストのトランザクション内で基準状態にそろえ、全変更をロールバックする。
- 検証環境のSQL読取以外に実データを変更せず、メール送信・本番反映・新規ジョブ作成は行っていない。

## 2026-10-16：5分ごとの内部監視

- 検証環境に `cargo_staging_monitor_state` とsnapshot/tick関数を追加。RLS有効、anon/authenticatedのテーブル参照・関数実行権限は撤回。関数はSECURITY INVOKER。履歴の無制限な追記はせず、最新結果・最終成功/失敗時刻・連続/累計失敗回数だけを1行に保持する。
- `staging-monitor-state.review.sql` のsnapshot部分は読取専用SQLと一致させ、SQL判定とNode判定の一致を隔離DBで検査する。監視失敗時はSQLエラー本文を保存せず `MONITOR_CHECK_FAILED` を記録し、直前の成功時刻を維持する。
- 監視処理は行ロック後に読み取って更新する。並行した古い結果による上書きを防ぐ。新しいメール・受付・削除・再送・修復処理は呼ばない。
- 監視ジョブは `cargo-staging-health-monitor`（job4）、`*/5 * * * *`、`select public.cargo_staging_monitor_tick();`。登録スクリプトは同名ジョブが存在したら拒否し、既存処理を上書きしない。
- 19:56 JSTの手動実行結果は正常、各異常件数0。ジョブ稼働・予定/コマンド一致、一般クライアントのSELECT/EXECUTE不可、受付OFFを確認した。
- `1c3a5fad1e4b47007ee6ac84f4c3f6b50e33a846` のsecurity/SQL run38890342397、browser run38890342399、staging smoke run38890342609は成功。通常/送信不明/停滞/ジョブ欠落/遅延/失敗/保護無効/受付状態、失敗回数と復旧、検査自体の失敗を隔離PostgreSQLで確認。
- advisorの追加INFOはservice専用テーブルのRLS/no-policyという閉鎖設計。クライアント権限を開けて解消しない。参照 https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy 。既存の漏洩パスワード保護WARNは今回変更していない https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection 。

### 記録の鮮度確認と監視自身の停止

権限のあるSQL画面で次を読む。行がない場合、`ok=false`、または`record_fresh=false`なら未確認/異常として扱う。古い正常記録を現在の正常と読み替えない。

```sql
select checked_at,ok,issues,last_ok_at,last_failure_at,
 consecutive_failures,total_failures,
 checked_at > statement_timestamp()-interval '10 minutes'
 and checked_at <= statement_timestamp()+interval '1 minute' as record_fresh
from public.cargo_staging_monitor_state where id=1;
```

ジョブ自身が停止した場合は記録も更新されない。DB障害・プロジェクト停止時も同様のため、DBの外側からの死活確認と通知は引き続き必要。メールやLINEへの障害通知は未接続であり、監視結果だけを根拠に自動送信しない。監視用の読み取り権限を一般公開しない。

### 定期実行の実確認

2026-10-16 20:00 JST、job4の実行履歴がsucceededとなり、監視行のchecked_atも20:00:00へ更新された。ok=true、issues=[]、連続/累計失敗0、intake_enabled=false。手動実行だけでなく、5分ごとのスケジュール起動を確認した。外部通知は未接続。
