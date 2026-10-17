# 本番顧客APIの限定配備記録

2026-10-17 00:30〜00:32 JST。対象プロジェクト：`kvoaorzdewwirqryeizq`。

## 範囲

DB初回導入完了の報告で「次は画面・APIとの接続や本番設定の確認」と提示した後、運営者の「進めて」を受け、一般受付OFF・メール全体枠無効を維持して顧客API3本を新規配備した。一般受付開始、本番メール試験、顧客画面公開、秘密値変更、定期処理追加は行っていない。既存の運転請負・決済関数は置換していない。

配備前にAPI一覧を確認し、以下3本が未存在であることを確認。ソースhead `08bb2e6e3339ee5965eaea1ff5a528382cc7f810` から取得した承認済み候補blobを照合した。各関数は単一index.ts、依存は固定版 `npm:@supabase/supabase-js@2.112.3`。

| API | version | verify_jwt | source blob |
| --- | --- | --- | --- |
| cargo-customer-intake | 1 | false | fcd98bf317889d7c7f4c49b40a4c0fd29ea825b9 |
| cargo-customer-review-operator | 1 | true | acee632b1822bb25812e340934b061b644fbcdec |
| cargo-customer-quote-reply | 1 | false | 488afd5d1acfb3a278e4275df56c8bd2debade79 |

公開呼出しの2本はそれぞれ受付ゲート/CAPTCHA/メール確認、およびHMAC付き回答リンクの検証を本体で行う。管理者APIはJWT検証に加えてgetUserとoperator所属確認を持つ。配備後get_edge_functionで3本の内容が候補ソースと完全一致、ACTIVE・version1・JWT設定も一致した。

## 本番URLへの限定確認

メール、実データ、認証コード、実回答リンクを用いず、以下6要求を実行した。

| ケース | HTTP | 結果 |
| --- | --- | --- |
| intake status | 200 | public_intake_enabled=false、ready=false、captcha_site_key=null、owner_test=false、注文/配車/決済=false |
| intake start（受付OFF） | 423 | PUBLIC_INTAKE_DISABLED |
| intake verify（受付OFF） | 423 | PUBLIC_INTAKE_DISABLED |
| operator list（Authorizationなし） | 401 | ゲートウェイがMissing authorization headerで拒否 |
| quote view（id/tokenなし） | 422 | INVALID_LINK |
| intake status（許可以外のOrigin） | 403 | ORIGIN_DENIED |

関数本体の応答でCache-Control: no-storeも確認した。401はゲートウェイの応答。これは未ログイン拒否の確認であり、正規管理者ログインや実回答リンクの本番動作確認ではない。

## 適用後のDB確認

2026-10-16 15:32:20 UTC（2026-10-17 00:32:20 JST）の読取：

- intake_enabled=false、captcha_required=true、contact_verification_required=true。
- 顧客メール全体枠enabled=false、hour_attempts=0、day_attempts=0。
- 下書き・依頼・見積もり回答・フォロー・フォロー履歴・保持削除実行履歴はすべて0行。
- 設定値や秘密値の読出し/変更、メール送信、受付ON、試験案件登録、削除は行っていない。

## 残る工程

- 本番用画面4ファイルの限定配備レビュー。開発ブランチ全体をmainへマージしない。
- 必須設定の存在/形式と本番配信枠のレビュー。今回のstatusは受付OFFのためready=false固定であり、全設定の準備完了を意味しない。
- 有効な管理者操作・本番公開経路・メール到着の限定確認は別工程。今回の拒否確認をE2E完了と扱わない。
- 本番用削除/監視、不正利用対策、外部取扱い表示、営業条件、一般受付開始の判断。
