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
