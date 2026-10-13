# Rainbow Driver 軽貨物｜顧客用受付の実装（レビュー用・未公開）

更新日: 2026-10-13

## 今回作成した利用者の動線
1. `cargo-customer-intake.html` : 集荷先・配送先・荷物・連絡先を入力し、画面で確認
2. Cloudflare Turnstileで不正利用防止確認、メールに6桁OTPを1通送信（**一般受付を許可し、すべての環境変数を設定して初めて動作**）
3. 10分以内に本人確認、最大5回まで照合
4. DBの1トランザクションでコードを使い切り、**暗号化した申込を審査待ちキューに1件だけ登録**。料金確定、ドライバー出動、決済、Pushはしない
5. `cargo-customer-review.html` : 管理者JWT＋`cargo_operator_accounts`照合後に申込一覧を表示し、審査開始・辞退・対応終了を記録。自動見積やメール返信はしない

## 対象ファイル
- `integrations/cargo-customer-intake/index.ts` : 公開用API（start/status/verify）、Turnstile、暗号化、メール送信、制限
- `integrations/cargo-customer-intake/operator.ts` : 管理者専用審査キューAPI（list/decision）
- `integrations/cargo-customer-intake/schema.review.sql` : 新規2テーブルとOTPの原子的確定RPC
- `integrations/cargo-customer-intake/schema-smoke.review.sql` : 一時PostgreSQLでのOFFゲートとOTP確定確認
- `cargo-customer-intake.html` : 顧客向け画面
- `cargo-customer-review.html` : 管理者向け受付審査画面

## 導入前の設定と承認（未実施）
- **現在の本番DBは受付OFF**。ユーザーの明確な公開承認なしに`cargo_intake_control.intake_enabled`を変更しない。新SQL・Edge・サイトのいずれも本番未適用。
- 公開用関数`cargo-customer-intake`は**デプロイ時に** `verify_jwt=false`が必要（メールアドレスの所有者はログイン前の顧客なので、SupabaseのユーザーJWTを要求しない）。ただしサーバー側でTurnstile検証と受付スイッチを必須にする。
- 管理者用関数`cargo-customer-review-operator`は**必ず**`verify_jwt=true`。さらに関数内で`auth.getUser(token)`と`cargo_operator_accounts`を検証。
- 公開用関数のシークレット（**実値はGitHubに書かない**）: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CARGO_INTAKE_HMAC_KEY`（既存のBase64秘密鍵）, `CARGO_CONTACT_AES_256_GCM_KEY`（既存のBase64 AES-256鍵）, `CARGO_CUSTOMER_EMAIL_PROVIDER=resend`, `CARGO_CUSTOMER_RESEND_API_KEY`, `CARGO_CUSTOMER_FROM_EMAIL`（検証済み送信元）, `CARGO_CUSTOMER_TURNSTILE_SITE_KEY`, `CARGO_CUSTOMER_TURNSTILE_SECRET`。
- 顧客に使用するメール送信事業者・ドメイン、個人情報保護方針、問い合わせ窓口、メール送信費用、保持期間、削除定期実行を確定すること。
- レート制限は既存`cargo_intake_rate_hit`を使用（1メールアドレスにつき1時間3件）。公開前にIP側制限と不正利用時の監視・ブロック運用も確認する。
- メール送信失敗時は下書きを削除する設計。通信断で実際の送信結果が不明の場合は自動再送しない。重複受付を防止するため`attempt_id`はユニーク制約。
- 管理者用審査画面の個人情報表示はログイン必須、`Cache-Control: no-store`、`textContent`で表示。DBテーブルはRLS有効・service_role限定。
- 受領した申込は見積もり/配送の確約ではない。**お客様に見積額や受諾結果を通知する機能は未実装**。運用責任者が審査フローを承認してから公開する。
- `cargo_dispatch_requests`（既存の軽貨物テスト案件）と、運転請負/Squareシステムは変更しない。

## 実行確認と制限
- 一時PostgreSQL上で新しいschemaの適用、受付OFF時の拒否、OTP誤答・正常回答・再利用禁止・期限切れ、原子的審査待ち登録、下書きの暗号文破棄を確認。
- 顧客画面・管理画面のインラインJavaScript構文を確認。
- **実際の顧客メール送信、外部メールプロバイダー接続、Turnstile実トークン、実Supabaseへのデプロイ、ブラウザE2Eは未実施**。

## 追加実装：見積もり下書きからお客様への明示的な回答（2026-10-14）
- `integrations/cargo-customer-intake/quotes.review.sql`：手動見積もりの金額・条件・有効期限・担当者・送信状態を別のRLS付きテーブルで管理する**レビュー用SQL**。公開ロールはアクセス不可、service_roleのみ。
- `cargo-customer-review.html`：管理者が審査中の申込を確認し、見積額（1〜10,000,000円）、税・高速料金・待機・荷役などの条件文（30〜1200文字）、有効期限（5分後〜14日以内）を入力して**下書き保存**するUI。送信前に改めて確認するボタンがあり、下書き保存だけでは送信しない。
- `integrations/cargo-customer-intake/operator.ts`：`quote_prepare`でサーバー側認証後、見積もりをDBへ保存。`quote_send`は明示確認値が必要で、DBで`cargo_intake_control`の受付スイッチON・審査中状態・未送信をロックして一度だけメール送信権を取得する。
- メールの送信には別途設定する**お客様用Resendプロバイダー**を利用する予定。Resendから受付IDが返った場合にのみ送信事業者受付済みとして記録。送信失敗・タイムアウト・不明状態では`delivery_unknown`として再送をブロックし、管理者の手動照合を必須にする。
- 見積もり送信で**受注・決済・ドライバー出動・自動請求は行わない**。金額は管理者の手入力であり、既存の採算試算結果から自動見積もりは行わない。
- `integrations/cargo-customer-intake/quotes-smoke.review.sql`：架空の申込を利用して、管理者以外による保存拒否、条件未入力拒否、下書きの修正、受付OFF時の送信拒否、一度限りの送信権、事業者受付済み/不明状態のDB記録を検証。
- GitHub Actions実行`38472207063`で、一時PostgreSQLの見積SQLを含む統合テストと従来のオフラインテストの2ジョブが**成功**：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38472207063
- **本番Supabaseへは未反映**。お客様宛の実メール送信も実施していない。請求書発行・税区分の自動判定・メール送信済みの手動照合UI・顧客による正式受諾は未実装であり、一般受付を公開する前に整備する。
