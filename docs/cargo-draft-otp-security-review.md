# 軽貨物・架空申込/OTP紐づけ セキュリティレビュー

更新日：2026-10-13

## 判定
**レビュー用コード作成・静的チェックは完了。DB適用とEdge Functionのデプロイは保留。**
Supabase開発ブランチは0件。独立したステージングDBを作成すると追加費用が生じる可能性があるため、費用確認・ユーザー承認前に作成しない。既存本番DBにもDDLを適用しない。

## 読み取り確認
- 本番の`cargo_intake_control`は`intake_enabled=false`、`captcha_required=true`、`contact_verification_required=true`。
- 既存OTPはチャレンジID、対象者HMAC、コードHMAC、期限、消費日時、試行回数を管理。既存の`cargo_email_verification_try`は行ロックと使用済み判定を実施。
- 新しい紐づけSQLは既存のOTPテーブルを参照し、独立した`draft_id`と`challenge_id`を一意にする設計。
- Supabaseセキュリティアドバイザーに警告あり：`pg_net`拡張がpublicスキーマ、漏洩パスワード保護が無効。既存RLS有効・ポリシーなしテーブル12件はサービス側専用設計のものも含むため、単純に公開ポリシーを追加しない。
- 詳細：https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public および https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## 静的チェック
GitHub上の実コードに対して以下16項目を検査し、16件合格：
- SQL: RLS有効、SECURITY DEFINERを使用しない、テーブル公開権限なし、RPC実行権限はservice_roleのみ、行ロック、二重claim拒否、旧コード拒否、事後bind拒否。
- Edge: サーバーでJWTを検証、operator会員資格を照合、受付OFFを確認、秘密HMACをサーバーのみで利用、受注テーブルへの書込なし。
- 画面: bindとclaimの双方が成功しない限り完了扱いしない、決済処理なし。
- チェックを継続実行するため`tests/cargo-draft-otp-security.test.cjs`を追加（`node --test tests/cargo-draft-otp-security.test.cjs`）。
- 上記16件は静的検査であり、Nodeテストランナー・SQLトランザクション・実Edge・Gmailを用いたE2E検証の成功を保証しない。

## ステージング導入前の必須レビュー
1. DBの新テーブル・RPCを隔離された開発環境で作成し、`anon`/`authenticated`に対する権限がゼロであることをSQLで確認。
2. 管理者以外のJWT・失効したJWT・不正な`draft_id`・別operator・異なるチャレンジ・同時claimをすべて拒否。
3. 正しいコードの確認前にはclaim不可。コード検証後は1回だけclaim可能。期限切れ、後から発行されたコード、消費済みコードは拒否。
4. bind後にGmail送信が失敗・期限切れとなった場合、孤立レコードを期限に沿って削除する仕組みを確認。
5. 認証済みという事実を実際の受注可否に直結させない。顧客向けAPIにはCAPTCHA、メール送信事業者、連絡先の保護、申込下書きの原子的な確定処理を別途実装。
6. GitHub PRをレビューし、ユーザーが検証環境の費用・反映範囲を了承するまでは本番マージ・DB変更・Edgeデプロイをしない。

## 公開判定
現時点：**公開不可**。管理者本人向け架空申込のプロトタイプであり、顧客向け受注システムではない。

## 追加の不具合修正・送信防止策
- SQLのclaim時刻判定を改善。行ロックの待機中にOTPが期限切れになる場合に備え、下書きとチャレンジの両方の行ロックを取得した後、`clock_timestamp()`を再取得して判定する。
- Edge Functionに読み取り専用の`status`を追加。新テーブルが存在し、専用RPCが権限付きで呼び出せることを検査し、準備が整っていない場合は`BINDING_NOT_READY`で拒否。
- 画面は**送信ボタンの有効化前と実送信直前の2回**、紐づけAPIの準備完了を確認する。新APIが未デプロイの現状ではGmail送信へ進めない。
- 追加の静的安全テスト2件をGitHubに記録。画面JS構文を確認し、模擬応答7ケース（正常、API未準備、bind失敗、claim失敗、誤コード、キャンセル、未ログイン）を実行して7件合格。
- 以上は**モック応答によるコードテスト**であり、実DBでの競合テストやメール実送信ではない。

## 次の導入ゲート
検証環境がない状態で新SQLやEdge Functionを本番に適用しない。費用の有無とステージング方式の承認を得た後、隔離環境でSQLトランザクション・権限・並列claimを検証する。

## 追加レビュー：ロック待ち・自動テスト（2026-10-13）
- DBの`cargo_operator_draft_otp_claim`を修正。行ロックの待機時間が長引いても、ロック取得後に`clock_timestamp()`を再取得し、期限切れコードを通さない設計に変更。
- GitHub Actions用の`.github/workflows/cargo-otp-review-tests.yml`を追加。Draft PRで変更された場合、Node標準のテストランナーでオフラインのテストファイル2つを実行する設定。
- `tests/cargo-draft-otp-flow.test.cjs`に、正常系・bind失敗・claim失敗・誤コード・受付条件違反・送信キャンセル・未認証/非管理者の7テストを追加。
- 2つのNodeテストファイルのJavaScript構文は確認済み。ただし、GitHub Actionsの実行履歴は現時点で確認できておらず、CI合格とは主張しない。
- データベースへのSQL適用、Edge Functionデプロイ、メール送信、本番ブランチへのマージは行っていない。

## 追加検証：テストの整合性（2026-10-13）
- 現行の管理者専用画面は、メール送信前に`cargo-draft-otp-binding`の`status`を二度確認する設計。未デプロイのAPIでGmailだけ送信しないよう、二重の準備確認を維持。
- 既存のブラウザモックが`status`応答を返しておらず、正常系を誤って失敗させていたため、`tests/cargo-draft-otp-flow.test.cjs`のモックを修正。
- API未準備時の送信停止と送信直前の再確認の2テストを追加。テスト定義はセキュリティ7件＋ブラウザ9件の合計16件。
- GitHubから現行ソースを読み込み、Node標準モジュールの一部を模擬したJavaScript検証環境で16件すべて成功。**Node本体のテストランナーやGitHub Actionsによる実行とは異なるため、CI合格・実API成功とは扱わない。**
- 本番DBへのDDL適用、Edge Functionデプロイ、実メール送信、mainへのマージは未実施。

## 独立PostgreSQL 16での実SQL統合テスト（2026-10-13）
- GitHub Actionsの`disposable-postgres-integration`ジョブが成功（実行ID `38395796752`）。
- Dockerで一時PostgreSQL 16を作成し、`tests/cargo-otp-pg-fixtures.sql`で架空ユーザー、管理者、OTPチャレンジ、受付OFF設定を準備。
- `design/cargo-operator-draft-otp-binding.review.sql`を**一時DBのみに**適用し、`tests/cargo-otp-pg-assert.sql`でSQL関数を実行。
- 成功した実SQL確認：RLS、anon/authenticated権限の拒否、service_roleでのclaim、認証の一度限りの使用、未認証拒否、期限切れ拒否、別管理者拒否、申込指紋改ざん拒否、古いOTP拒否、事後bind拒否、受付OFF条件の検証。
- 同実行の`offline-security-contract`ジョブも成功（Nodeテスト16件）。
- 実行結果：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38395796752
- **本番SupabaseのDBにはSQLを適用していない。新Edge Functionは未デプロイ。実Gmail送信も行っていない。**
- 本番の受付設定を再確認：`intake_enabled=false`、`captcha_required=true`、`contact_verification_required=true`。
- 残る課題：Supabase固有の実環境認証、Edge Function実行、実Gmail、同時claimの競合テスト、顧客向け申込との紐づけ。今回の成功だけで一般受付を公開しない。

## 同時実行・ロック待ち期限切れテスト：実行成功（2026-10-13）
- GitHub Actions 実行ID `38398206796`：`offline-security-contract`、`disposable-postgres-integration` の両ジョブが成功。
- 一時PostgreSQL 16に対し`tests/cargo-otp-pg-concurrency.py`を実行。**同一申込への並列claimは1件のみ成功、もう1件は`ALREADY_CLAIMED`**。DBに記録されたclaimは1件。
- 行ロックの待機中に期限切れとなったOTPは`EXPIRED`で拒否され、claim記録は0件。
- 実行ログに`PASS: concurrent claims yield exactly one success and one replay rejection`および`PASS: code expiring while waiting for a row lock cannot be claimed`を確認。
- 実行結果：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38398206796
- 本番SupabaseへのDDL適用・Edge Functionデプロイ・Gmail送信・PRマージは行っていない。顧客向けの本番E2Eは依然未実施。

## 管理者専用Edge Functionのオフライン動作確認（2026-10-13）
- `tests/cargo-draft-otp-edge.test.cjs`を追加し、**レビュー中の実際のEdge Functionソース**をメモリ内で実行。Supabase DB/認証/Gmailをモック化し、ネットワークや本番シークレットを使用しない。
- 7件：Bearer認証・Origin、JWT・管理者権限、受付ON拒否、read-only準備確認、OTP subject一致・不一致、claim成功・拒否、無効IDの事前拒否。
- 既存16件と合わせたオフライン**23件すべて成功**。一時PostgreSQLのSQL検証・二重claim・ロック待ち期限切れも成功。
- GitHub Actions 実行ID `38399153744`、両ジョブ成功：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38399153744
- 初回の新規テスト失敗は架空challenge IDがUUIDの桁数不足だったため。架空IDを修正し再実行で成功。Edge Functionの本番ソースはこの修正では変更していない。
- **未検証**：実Supabase Edge Functionデプロイ、実セッションを用いたAPI呼び出し、ブラウザからのE2E、顧客向け受付。PRはDraftのまま。本番DB・メール・受付・決済には変更なし。

## 実Supabaseの導入前チェック（2026-10-13）
- 本番DBをSELECTのみで確認：`cargo_intake_control.intake_enabled=false`、`public.cargo_operator_draft_otp_bindings`テーブルは未作成、`public.cargo_operator_draft_otp_claim` RPCも未作成。したがって管理者専用画面の`cargo-draft-otp-binding` readiness は現状未準備で、Gmail送信前に停止するのが正しい挙動。
- 新規Edge Functionはレビュー中で未デプロイ。**本番DBへのDDLや本番メール送信を行わない**。
- `tests/cargo-draft-otp-edge.test.cjs`を11件へ拡張：テーブル未作成、RPC未作成、書き込み失敗、不正HTTPメソッド・不正入力、許可されないOrigin、OPTIONSプリフライトを追加。テスト用モックでのHTTP 204空レスポンス処理も正しく実装。
- Supabase公式ドキュメントを確認：ブラウザからのEdge Function呼び出しではCORSプリフライト処理が必要。認証済み呼び出しではユーザーJWTの検証と権限確認が必要。
- セキュリティアドバイザは既存の`rls_enabled_no_policy`（サービスロール専用テーブルを含む）および`extension_in_public`などを報告。既存のアプリ全体に関わるため今回の作業では変更していない。参考：https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
- 次の実環境統合には、本番と切り離されたSupabase環境、もしくは明示的に承認された本番側の管理者専用導入が必要。導入前にDBバックアップ、JWT設定、service_role秘匿、RLSとアクセス権限、ロールバックを確認する。

## 架空申込の期限切れ紐づけ整理（2026-10-13）
- `design/cargo-operator-draft-otp-binding.review.sql`に`cargo_operator_draft_otp_cleanup(p_limit integer default 100)`を追加。**レビュー用で、本番DBには未適用**。
- `service_role`だけが実行可能。呼び出しごとの削除上限は100件、対象は`delete_after < clock_timestamp()`となった**架空申込の紐づけ行のみ**。ロック済み行は`FOR UPDATE SKIP LOCKED`で回避。
- 無効な上限指定は0件で停止。OTPチャレンジ本体、顧客連絡先、配送受注、決済データは削除しない。cronや自動スケジュールは追加していない。
- `tests/cargo-otp-pg-cleanup.sql`で実PostgreSQL 16の一時DBに対して、公開ロールの権限拒否、service_roleの実行権限、上限2件、残り1件の削除、未期限切れ保護、OTP保持、繰り返し実行時0件を確認。
- GitHub Actions 実行 `38401724012` のオフラインジョブ・一時PostgreSQL統合ジョブはいずれも**成功**：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38401724012
- 後続の静的テストにも整理処理の上限・権限・削除対象制約を追加した。
- 本番の`cargo_intake_control`を読み取り専用で再確認：`intake_enabled=false`、`captcha_required=true`、`contact_verification_required=true`。
- 残課題：本番から隔離されたSupabase検証環境でのJWT・RLS・Edge実行、保持期限ポリシーと削除スケジュールの承認。新規環境には追加費用の可能性があるため、ユーザーの承認なく作成しない。

## 実際の軽貨物申込プレビューの前進（2026-10-13）
- `cargo-request-preview.html`の下書き確認に、共通の純粋関数`cargo-pwa/request-review-rules.js`を接続。入力項目をまとめて検証し、準備状況・荷役条件・積載確認などの**手動審査事項**を画面に表示する。
- 既存のフォーム項目・デザイン・一般受付OFFを維持。モジュール自体はネットワーク・DB・ストレージ・メール・決済にアクセスしない。常に`canSubmit:false`、`canBook:false`、`priceFinalized:false`、`requiresOperatorReview:true`。
- `tests/cargo-request-review.test.cjs`で8件の境界値・入力・手動審査・無通信テストを追加。既存28件と合わせて**36件成功**。
- GitHub Actions `38402578959`でオフライン36件・一時PostgreSQL統合の両ジョブ成功：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38402578959
- これは本番の顧客申込API接続や一般公開ではない。公開ページに反映するためのPRマージ、実ブラウザE2E、実Supabaseの管理者専用導入は未実施。
- 既存の管理者限定「架空案件のテスト登録」は今回変更していない。実顧客の情報は入力しないこと。

## 実際の申込プレビュー → 管理者Gmail認証テストへの導線（2026-10-13）
- `cargo-pwa/fictional-flow.js`を追加。集荷地・配送先・荷物・個数・重量・寸法・補足・氏名（「テスト担当者」）・連絡先空欄など、**固定架空のサンプルのみ**を共通化。`sample()`、厳密一致`matches()`、認証用の固定`otpSample()`を提供。顧客の入力を保存・送信しない。
- `cargo-request-preview.html`は管理者ログイン済み、下書き確認済み、固定サンプルと**全項目の完全一致**、確認チェック済みの場合にだけ、`./cargo-request-otp-integration-preview.html`への固定リンクを表示する。
- 入力変更・確認チェック変更・再編集時は即座に導線を非表示にする。住所、連絡先、氏名、メモ、認証トークン、OTPはURLクエリ・フラグメント・ストレージで渡さない。
- 遷移先の`cargo-request-otp-integration-preview.html`は共通モジュールから同じ固定架空サンプルを再生成する。遷移自体ではメール送信されず、管理者認証・受付OFF・専用API準備確認・明示的なメール送信確認が必要。
- `tests/cargo-request-review.test.cjs`にリンクの静的URL制約、固定値の厳密照合、管理者/未ログイン/編集後のUI挙動を追加。`tests/cargo-draft-otp-flow.test.cjs`も共通架空モジュール利用に更新。
- 初回の追加UI試験が「入力変更でリンクが隠れない」不具合を発見したため、フォームの入力・チェック変更イベントに`updateOtpHandoff()`を追加して修正。
- GitHub Actions 実行 `38407394838`：**オフライン40件すべて成功**、一時PostgreSQL統合テスト成功。結果：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38407394838
- **公開サイトには未反映**。このリンクを介しても実顧客の申込内容とOTPはサーバー上で結びつけられない。新しいSupabaseの紐づけテーブル・Edge Functionは本番未導入。実メールE2E・本番の受注・決済は実施しない。Draft PRを維持。
