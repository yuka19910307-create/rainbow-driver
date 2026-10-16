# 本番の停止中設定診断（レビュー用・未配備）

`index.ts` は、本番 `kvoaorzdewwirqryeizq` の設定を、一般受付OFF・顧客メール枠無効のまま管理者が確認するための追加API候補。既存3本のAPIと固定候補manifestは変更しない。実サービスへの配備・実行、秘密値の追加や変更はこの実装には含まない。

配備名候補は `cargo-production-readiness`、`verify_jwt=true`。入力は `{"action":"status"}` のみ。本文を一括取得せず、Content-Lengthと実際の受信量を384バイトまでに制限し、既存の128文字上限も維持する。過大本文や不正UTF-8は認証サービスへの問い合わせ・設定の読取前に拒否する。正規管理者のユーザーJWTで `getUser` と `cargo_operator_accounts` を確認し、本番接続先、CAPTCHA/メール確認必須、一般受付OFF、顧客メール枠無効の条件がそろってから設定を調べる。通常ログイン利用者や未ログイン利用者には診断を返さない。ユーザーJWTや秘密値をチャット・URL・コマンド行へ記入しない。

## 確認できること

- HMAC鍵が既存受付APIの受け付けるBase64の32/64バイト、暗号化鍵がBase64の32バイトであること。
- Turnstile設定の存在、Resend指定とAPIキーの存在、送信元が既存受付/見積もりAPI双方の形式を満たすこと。
- 顧客OTPと見積もりメールに共通の時間/日上限、保存中の使用回数、集計期間。これらは設定・件数だけで、顧客情報を含まない。古い期間の使用回数を現在期間へリセットしない。

設定値・値の長さ・鍵のハッシュ・認証情報・メールアドレスは返さない。申込テーブルやメール内容は読まない。DB操作は管理者所属、受付スイッチ、メール枠のSELECTだけで、RPC・更新・メール配信・再送は行わない。エラー本文も返さず固定コードで停止する。

## 確認できないこと

形式が正しくても、本番の鍵が正しいこと、配信サービスに接続できること、送信元ドメインやTurnstile設定が有効なこと、メール到着を保証しない。`external_checks` はすべて `not_checked`、`launch_ready=false`。メール枠の数値を読み取っても、運営者による本番上限の承認とは扱わない。

別関数から確認する環境設定は、この診断関数自身に読み込まれた値についての結果。`runtime_scope=THIS_DIAGNOSTIC_FUNCTION_ONLY` と返し、既存3本の配備済みAPIが同じ設定を読み込んでいる証明とは扱わない。既存APIごとの設定・配備内容との照合と、別途承認された限定本番経路の確認は残る。

Resendのアカウント、キーの送信対象/権限、検証ドメイン、契約上限、使用済み量は管理画面等で別途読取確認する。顧客送信キーの権限を、診断の都合で全権限へ広げない。送信APIへダミー要求を送る確認はしない。Supabase AuthのSMTP設定はこの顧客メール経路とは別であり、SMTP設定の存在だけで顧客配信準備完了とは判定しない。

## ローカル検証

```bash
node --test tests/cargo-production-readiness.test.cjs
```

Node 24のTypeScript除去を使って実ハンドラーを実行し、架空の認証/SELECT/環境設定だけで権限、停止条件、秘密値を出さないこと、未設定の検出を確認する。DB・外部サービス・実メールの試験ではない。

公式資料（2026-10-16、Supabase docs searchで確認）：

- [Authorization headers / verify_jwt](https://supabase.com/docs/guides/functions/auth-headers)
- [Integrating With Supabase Auth / getUser](https://supabase.com/docs/guides/functions/auth-legacy-jwt)
- [Edge Functions / project secrets](https://supabase.com/docs/guides/functions)

統合担当が `https://supabase.com/changelog.md` を取得確認済み。関連するbreaking-changeは2026-11-10の旧TLS cipher停止の告知で、今回の固定SDKを変更する必要はない。既存の固定版 `supabase-js@2.112.3` と既存APIで使用中の認証/SELECT方式を維持し、新しいSupabase機能・設定方式は導入していない。
