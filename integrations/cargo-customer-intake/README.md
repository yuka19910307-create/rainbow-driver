# Rainbow Driver 軽貨物｜顧客用受付の実装（レビュー用・未公開）

更新日: 2026-10-15

> 最新の開発状況は [相談区分と安全対策の継続記録](../../docs/cargo-consultation-flow-continuation.review.md) を参照。本番DB/API/画面の導入記録は同文書の参照先にあり、以下の「未導入」は作成当時の履歴。今回の開発変更は本番未配備。
> 従来の状況は [公開準備記録](../../docs/cargo-release-readiness-20261015.md) と [本番反映・復旧手順](../../docs/cargo-production-rollout.review.md) を参照。
> 以下には作成当時の記録も含まれる。「未実施」「未実装」の古い記述は最新記録と照合する。
> 現在、検証環境ではTurnstile・所有者メール到着・暗号化・所有者限定OTP通し確認、終了/保留操作、期限後の一式削除、継続相談と見積もり期限の分離を実装・検証済み。
> 本番顧客用6テーブル/RPCと顧客ページは未導入。一般受付OFF。本番の移行前確認SQLは production-preflight.review.sql（読み取りのみ）。
> 受付開始、実顧客メール、無関係な運転請負・Squareの変更は含まない。

## 今回作成した利用者の動線
1. `cargo-customer-intake.html` : 集荷先・配送先・荷物・連絡先を入力し、画面で確認
2. Cloudflare Turnstileで不正利用防止確認、メールに6桁OTPを1通送信（**一般受付を許可し、すべての環境変数を設定して初めて動作**）
3. 10分以内に本人確認、最大5回まで照合
4. DBの1トランザクションでコードを使い切り、**暗号化した申込を審査待ちキューに1件だけ登録**。料金確定、ドライバー出動、決済、Pushはしない
5. `cargo-customer-review.html` : 管理者JWT＋`cargo_operator_accounts`照合後に申込一覧を表示し、審査開始・辞退・契約なし終了、手動見積もり下書き・明示操作による見積もり送信、利用希望への対応履歴を扱う。自動受諾・自動見積もりはしない

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

## 追加実装：お客様の見積もりへの希望回答（2026-10-14）
- `cargo-customer-quote-reply.html`：メール内の専用リンクから、見積もり金額・条件・有効期限を確認。「この条件で利用を希望する」「今回は見送る」のどちらかを一度だけ回答。**正式予約・契約締結・配車・決済ではない**。
- `integrations/cargo-customer-intake/operator.ts`：管理者が見積もりの実メール送信を承認した際、暗号学的乱数から32バイト（256bit）の一回限りの秘密トークンを生成。サーバーにはその秘密そのものを保存せず、既存の秘密鍵から生成したHMACだけを記録。メールに`#r=申込ID&t=トークン`というURLフラグメント付きリンクを記載（検索クエリではなく、HTTP要求にはフラグメントを送信しない）。
- `integrations/cargo-customer-intake/quote-reply.ts`：新しいお客様向けAPI（`view`/`reply`）。トークン照合・見積もり送信済み・期限内・本人の一度限りの回答・受付ONをサーバーRPCで確認。**必ずverify_jwt=falseでデプロイする設計**だが、事前承認まで未デプロイ。
- `integrations/cargo-customer-intake/quotes.review.sql`：一回限りのHMAC照合、行ロック、回答（`interested`/`declined`）の保存、再回答拒否、受付OFF拒否、返値の`contract_confirmed=false`・`dispatch_created=false`・`payment_created=false`。
- `cargo-customer-review.html`：管理者の審査一覧に送信済み見積もりと「利用希望」「見送り」を表示し、担当者が後から確認する。
- `integrations/cargo-customer-intake/quotes-smoke.review.sql`：隔離PostgreSQLでのトークン不一致拒否、本人の見積もり確認、1回限りの利用希望回答、再回答拒否、受付OFFによる回答停止を実行。
- GitHub Actions `38475123521` でオフラインジョブ・一時PostgreSQL統合ジョブの両方成功：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38475123521
- **本番サイト・Supabaseへの変更なし**。Resendでの実メール送信、顧客の実回答、顧客との契約合意、Square決済連携は未実施。一般受付OFFのままで、運転請負アプリへの影響はない。
- 公開前に、利用規約や申込確認内容、契約成立タイミング、キャンセル・返金ルール、見積額の税区分、連絡先と個人情報の保持期限を確定する。お客様の「利用希望」だけで正式受諾しない設計を維持。

## 管理者の見積もり「利用希望」への対応記録（2026-10-14）
- `integrations/cargo-customer-intake/followup.review.sql`：見積もり送信済み、かつ利用希望の回答がある案件のみ、管理者が対応状況とメモを保存。ステータスは「連絡済み」「返答待ち」「個別対応終了」「受注に至らず終了」の4種類。変更履歴を別テーブルに記録。
- `integrations/cargo-customer-intake/operator.ts`：`followup` APIを追加。本人JWTと`cargo_operator_accounts`を照合したうえで、楽観的排他制御・正しい段階遷移・受付スイッチをサーバー側で検証。`list`は最新の対応記録を表示する。
- `cargo-customer-review.html`：利用希望の案件に限り、対応状況の選択と5〜600文字の業務メモを表示。完了後の再開はできない。
- `integrations/cargo-customer-intake/followup-smoke.review.sql`：隔離PostgreSQLで、受付OFF拒否・権限拒否・状態遷移・二重更新拒否・業務記録保存・終了後の再開禁止・履歴件数を検証。
- GitHub Actions `38479056117`：オフラインテストと隔離PostgreSQL統合テストの両ジョブが成功：https://github.com/yuka19910307-create/rainbow-driver/actions/runs/38479056117
- **対応状況は業務記録のみ。顧客への自動連絡、契約確定、配車指示、Square決済は行わない。** 本番Supabaseへの適用・PRマージも未実施。

## 検証環境の送信受付判定を修正（2026-10-14）
- 顧客OTP APIのメール送信受付判定はHTTP成功だけではなく、ResendのJSON応答に空でないメールIDがある場合に限る。不正JSON・ID欠落・エラー・タイムアウトは未確認として扱い、自動再送しない。事業者受付は受信箱への到着を保証するものではない。
- `tests/cargo-customer-email-acceptance.test.cjs`で正常応答、ID欠落・型不正・空白・過長ID、不正JSON、HTTPエラー、タイムアウトと自動再送なしを検証。受付OFFでは外部送信に進まないことも検証。
- 分離検証プロジェクト `hvdoqcrnztqmbzgwrovd` の `cargo-customer-intake` Version 5 に反映。公開JWT不要の既存設定を維持し、受付OFFとCAPTCHA必須条件は変更なし。実際の顧客メール送信・本番プロジェクトへの反映は行っていない。
