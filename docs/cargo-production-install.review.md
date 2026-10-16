# 顧客受付データベースの初回導入案

2026-10-16作成、2026-10-17更新。**本番DB初回導入は運営者承認の範囲で実施済み**。一般受付OFF・メール送信停止。以下の計画は履歴として残し、初回SQLは再実行しない。

## 用意したもの

- `scripts/build-cargo-production-install.cjs`：固定候補のSQL5点のGit blob SHAを検証し、依存順に1つのトランザクションへまとめる。SQLの実行、接続、デプロイ、メール送信は行わない。
- `integrations/cargo-customer-intake/production-initial-install.generated.review.sql`：生成済みの具体的なレビュー対象。元のSQLファイル名とSHAを収録する。
- 対象は新しい顧客用7テーブルとその関連関数・権限だけ。既存の認証ユーザー、operator所属、運転請負、Square、CNAME、検証専用台帳・監視・試験関数は含めない。ジョブ・関数の配備・秘密値の設定も別工程。

## 事前条件と停止条件

本番の対象は `kvoaorzdewwirqryeizq`。2026-10-16の読取では内部受付OFF、CAPTCHA/メール確認必須、顧客用7テーブルなしを確認した。実行前にはプロジェクトの選択・接続先と最新状態を再確認する。SQLのコメントは実接続先の証明ではない。

開始時にcontrolテーブルへ短いロックを取り、受付OFFと保護設定、operatorの存在、既存コアに必要なservice_role権限を確認する。ロック待ちは5秒、各SQL文のタイムアウトは60秒。

対象のテーブルや `cargo_customer_` 接頭辞の関数が既にある場合は停止する。途中まで入った環境や、既存顧客システムの更新には使わない。既存の定義を自動で置換して復旧しない。

1つでも失敗すれば全体をロールバックする。完了前にも受付OFF・保護設定、7テーブルのRLS、anon/authenticatedへの公開権限がないこと、顧客関数がSECURITY INVOKERで通常クライアントから実行できないことを確認する。

## 元SQLからの変更

元ファイルの先頭のレビュー/検証用コメントと各ファイルのBEGIN/COMMITを除き、依存順の本文を保持する。外側に1つのBEGIN/COMMITと事前・事後条件を追加する。

明示的なデータ差分はメール全体枠の初期行だけ。検証用の10回/時・50回/日を引き継がず、`enabled=false`、上限1/1の停止用プレースホルダー、使用回数0で作る。停止状態なので送信枠は取得できない。本番上限は運用量と他の送信経路をレビューして別途設定する。金額や料金表とは無関係。

受付スイッチをONにするSQL、テストユーザー・架空顧客データの投入、外部への送信、定期削除の自動登録は含まない。

## 再生成と確認

新しい出力先を指定する。既存ファイルがある場合は上書きしない。

```bash
node scripts/build-cargo-production-install.cjs . /tmp/cargo-production-install-review.sql
node --test tests/cargo-production-install.test.cjs
```

生成結果を承認済み候補と照合する。元SQLのSHAが変わった場合は、レビューせずmanifestだけを更新して通過させない。生成済みSQLと生成器の一致も自動検査する。

## 本番反映前に残る確認

1. 対象プロジェクト、既存コアの権限とoperator、復旧対象の版を再確認する。
2. 生成済みSQLと差分、メール枠の初期停止をレビューし、本番実行範囲を確認する。
3. 導入後も受付OFFを維持し、API・画面・秘密値・メール配信設定・本番用の削除/監視を別途整える。
4. 公開条件、不正利用対策、限定した本番経路確認、一般受付開始の判断を完了する。

SQL実行時はエラーで確実に停止するトランザクション対応の経路を使う。接続情報や秘密値をチャット/Gitへ貼らない。失敗後にテーブルをDROPして再実行する手順ではない。

## 検証完了と本番反映前の確認（2026-10-17）

- 対象の生成済みSQL blob：`14219afecf1f2dd392c3d8fb5e321c9fbf64db74`（ソースhead `6b5adae58c05855bfb3c232935959f39af0b7346`）。本番未実行。
- CI：security/SQL `38892282167`、browser `38892282118`、staging smoke `38892282252`がすべて成功。
- 隔離DBで6ケース成功：保護された受付OFFでの初回導入、受付ON拒否、保護設定無効時の拒否、既存テーブルの保護、既存顧客関数の保護、途中エラーによる全体ロールバック。初回導入後の再実行も拒否する。既存operator行が保持されることも確認した。
- 2026-10-17の本番読取：protected_off=true、operator_present=true、service_roleのcontrol SELECT/UPDATEとoperator SELECT=true、顧客用7テーブル0件、顧客関数0件。初回導入ガードの前提に一致する。
- 次に確認する実行範囲：本番プロジェクト `kvoaorzdewwirqryeizq` へこのSQLだけを1トランザクションで適用し、空の顧客用保存先と関連処理を追加。内部受付はOFF、メール全体枠は無効のまま、既存コアの行・運転請負・決済・ドメインを変更しない。顧客API/画面/秘密値/cronの配備や受付開始は含めない。
- 本番へ初めてデータベース変更を加える工程のため、この具体的な反映範囲を運営者へ提示して確認する。承認後も直前の状態再取得、SQLハッシュ照合、適用後のRLS/権限/OFF/枠無効/空テーブル確認を行う。今回の準備を一般受付開始の承認に読み替えない。

## 2026-10-17 00:16〜00:20 JST：承認範囲で本番DBへ反映済み

- 00:16 JST、運営者が「一般受付OFF・メール送信停止のまま、本番に保存機能を追加」の具体的範囲に対して「進めて」と承認。今回の承認はDB初回導入だけで、一般受付ON・実メール・API/サイト/秘密値/cron配備の承認に拡張しない。
- 対象：`kvoaorzdewwirqryeizq`。承認済みSQL blob `14219afecf1f2dd392c3d8fb5e321c9fbf64db74` を再取得して一致確認。直前の読取で保護されたOFF・コア権限・operator1行・control1行・顧客テーブル0/関数0を確認した。
- `cargo_customer_initial_schema_protected_off` をapply_migrationで適用し成功。新しい7テーブルと11関数を追加。既存control/operator行の変更は行っていない。
- 00:19 JSTの適用後検証：7テーブルすべてRLS有効、anon/authenticatedのSELECT/INSERT/UPDATE/DELETE権限なし。11関数すべてSECURITY INVOKER、anon/authenticatedのEXECUTEなし。顧客の下書き・依頼・見積もり・フォロー・イベント・削除履歴はすべて0行。
- 内部受付false、CAPTCHA/メール確認trueを維持。メール全体枠はenabled=false、上限1/1の停止用プレースホルダー、使用回数0。control1行・operator1行を維持。メール送信・テスト案件投入・自動削除の起動なし。
- advisorはservice専用RLS/no-policyのINFO、および今回のSQLで変更しない既存pg_net配置/漏洩パスワード保護のWARN。新しい通常クライアント権限を開けてINFOを解消しない。参照：
  - https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
  - https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public
  - https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
- 初回導入SQLの再実行は禁止。今後は既存スキーマの前提で変更をレビューする。空のテーブルを作れたことを、公開顧客経路や本番メールE2E成功と扱わない。
- 次の工程：本番用API/設定/画面の限定レビュー、メール上限と外部取扱い、削除/監視、本番経路の限定試験と公開条件。不正利用対策・契約/費用/キャンセル条件の確認、一般受付開始の判断は引き続き未完了。


## 2026-10-17 00:30〜00:32 JST：後続のAPI限定配備

DB導入後の次工程として運営者の「進めて」を受け、顧客API3本を新規配備した。受付OFF・メール全体枠無効を維持し、HTTP状態/拒否6ケース、配備ソースの一致、顧客データ/送信回数0を確認。詳細は [cargo-production-api-deployment.review.md](cargo-production-api-deployment.review.md)。画面公開・秘密値変更・実メール試験・cron追加・一般受付開始は行っていない。
