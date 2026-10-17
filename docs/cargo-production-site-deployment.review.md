# 本番顧客画面の限定接続記録

2026-10-17 00:39〜00:47 JST。運営者の「進めて」を受け、本番API追加後の画面接続を進めた。一般受付開始の承認として扱わない。

## 配備範囲

main基準 `f6a92db33745f8e9a928eb32a6221cc0f9371cf3` へ次の4ファイルだけを追加。公開コミット `5b788f9b330796eb6d0933e32202e550a91bfc97`。開発ブランチの一括マージ、ナビゲーション変更、既存ページの置換は行っていない。

| ファイル | レビュー済みblob |
| --- | --- |
| cargo-customer-intake.html | 2fee31e2d072e3aba846c27c4d55cd974130b4a7 |
| cargo-customer-review.html | fc31f3608c2755b4a8e905a61b1bfbccad4a3cd7 |
| cargo-customer-quote-reply.html | d238355a00103bc506876580caf61281e5a415fe |
| cargo-pwa/request-review-rules.js | a0d7fe3bf5f4a8fdb7dee62a55d19b5517c33da2 |

候補manifestを最新dev `a707226686941eb765a5f55b9e7655ae1fdc98fa` から読み直し、blob一致・JS構文・検証環境/秘密鍵の参照がないことを確認。本番URLとpublishable keyは本番APIと一致。既存管理者ログイン・申込プレビューを依存として利用する。

## 確認結果

- 配備直前の本番intake status：HTTP200、public_intake_enabled=false、ready=false。
- Pages workflow `38926292583` 成功。
- 本番サイトから4ファイルをGETしHTTP200、内容のGit blobが上表と完全一致。
- 既存依存2ファイルもHTTP200、変更前blobと完全一致：
  - cargo-operator-login.html：05c964c921d69330e163e21259895957f5147406
  - cargo-request-preview.html：1a562ceb86b14a24724c4650b0c26bc4320c7ebf
- 実ソースをNode VMの最小DOMで実行して確認：
  - 申込：statusがOFFなら受付停止表示、確認/送信ボタン無効。submit・送信・認証ハンドラを直接呼んでも追加API要求なし。
  - 管理者：未ログインならログイン案内、審査API要求なし。
  - 回答：リンク情報なしなら見積もり・回答操作を非表示。ハンドラを直接呼んでも通信なし。
- VMは実ブラウザの描画確認ではない。最初の試験の「リンクなしでdisabled=true」という仮定は実装と異なり、実際の仕様である非表示＋ハンドラのloadedガードに照合し直した。コード変更で試験を通したものではない。
- 既存の検証環境でのブラウザ/メール一連確認は完了済みだが、それを本番の正規メール経路の完了と扱わない。

00:46:50 JSTのDB読取：内部受付false、CAPTCHA/メール確認true、顧客メール枠enabled=false、使用回数0/0、下書き/依頼/見積もり回答0行。

## 未完了事項

受付OFFのstatusではready=falseになるため、メール・HMAC・暗号化・Turnstileなど全必須設定の形式や有効性は判断できない。今回、秘密値の読出し/変更や実メール送信を行っていない。接続確認を設定完了と表現しない。

本番用配信設定・上限、信頼できる不正利用対策、監視/削除、外部取扱い案内と営業条件、限定した本番E2E、一般受付開始判断は残る。受付停止中は個人情報を入力しない案内を表示する。料金・最低料金・営業時間等の未定条件を推測で公開しない。
