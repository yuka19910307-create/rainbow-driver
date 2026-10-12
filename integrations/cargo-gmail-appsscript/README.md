# Rainbow Driver Cargo — Google個人Gmailの本人確認テスト

**公開前・管理者本人宛テスト専用。一般受付の有効化には使用しない。**

## Google側設定

1. 個人Gmailで https://script.google.com/ を開き、「新しいプロジェクト」を作成する。
2. プロジェクト名を `Rainbow Driver Cargo Mail` にする。
3. `Code.gs` の初期コードをすべて削除し、このフォルダの [Code.gs](./Code.gs) を全文コピーして貼り付け、保存する。
4. エディタ上部の実行関数を `setupBridge` に選択して実行する。
5. 続けて `authorizeMail` を実行し、本人のGoogleアカウントで送信権限を許可する。
6. 「プロジェクトの設定」→「スクリプト プロパティ」を確認する。
   - `OWNER_EMAIL` は本人の `@gmail.com` であること
   - `TEST_SEND_ENABLED` は初期値 `NO`（送信しない）
   - `BRIDGE_HMAC_SECRET` は秘密値。**チャット・GitHub・スクリーンショットに表示しない**
7. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」。実行者は「自分」、アクセスできるユーザーは「全員」にする。公開URL (`https://script.google.com/macros/s/.../exec`) を取得する。
8. Supabase の Edge Functions Secrets に以下を設定する。
   - `CARGO_GMAIL_BRIDGE_URL`：デプロイ URL（/exec まで）
   - `CARGO_GMAIL_BRIDGE_HMAC_SECRET`：Apps Scriptプロパティの `BRIDGE_HMAC_SECRET` と同じ値
9. `https://app.rainbow-driver.com/cargo-pwa/gmail-otp.html` で「設定を再確認する」を押して両方の設定が認識されることを確認する。
10. **本人宛てテスト実行時に限り** `TEST_SEND_ENABLED` を `YES` に変更する。管理者画面からテスト送信し、Gmailで受け取った6桁を入力する。
11. 確認が終わったら `TEST_SEND_ENABLED=NO` に戻す。

## 安全条件

- Googleから送信できるのはApps Script所有者の個人Gmailのみ。リクエストで送信先を指定するAPIは存在しない。
- Supabase Authの管理者確認が必要。管理者でない場合は拒否する。
- 署名付きリクエストをGASで検証し、90秒以内の時刻・一度限りのnonceでリプレイを拒否する。
- Supabaseの送信試行上限は3回/時間（管理者単位）、GASは最大10通/日（独自上限）。
- 認証コードはSHA-256 HMACハッシュとしてDBに一時保存、10分で失効、5回の誤入力でロック、認証成功後は再利用不可。
- 既存の `cargo_intake_control.intake_enabled=false` を変更しない。
- 運転請負システム、Square決済、既存配送案件には変更を加えない。
- **実際の顧客向け送信・受付は未実装**。本番導入には別途設計・セキュリティ試験が必要。

**重要：** Apps Scriptの「全員」アクセスは署名認証付きのサーバー間HTTPを実現するため。署名シークレットが漏れないよう厳重に保管する。万一漏えいした場合はGoogle Apps ScriptとSupabase両方の署名キーを入れ替える。