# 軽貨物の合意記録・正式受注・配送状態 API（開発候補・未配備）

第1工程の管理者専用API。既存の相談ID、本人認証済み相談、審査、手動見積もりを参照するDB差分と対で使用する。顧客画面、管理画面のボタン、本番・検証サービスへの配備は今回含まない。利用希望だけでは合意記録・受注にしない。

## 権限と安全な停止

- 将来の配備でも `verify_jwt=true` を維持する。関数内で `auth.getUser(bearer)` と `cargo_operator_accounts.user_id` を照合し、DB RPCでも運営者所属を再確認する。
- Originは既存アプリと同じ固定値を厳密照合。POSTのみ。受信本文はストリームで36,000 bytes、解析前に12,000文字を上限とし、未知の項目・不正なUUID・整数・確認値を拒否する。
- 環境変数は既存の `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`CARGO_CONTACT_AES_256_GCM_KEY` のみを使う。実値をGit・画面・ログへ記載しない。既存と同じpinned supabase-js 2.112.3、AES-256-GCMのversion 1（1 byte版番号＋12 byteランダムIV＋暗号文と認証タグ）を使う。
- RPC未導入、権限照会障害、暗号文破損、欠落・不一致のDB結果は503で停止する。直接UPDATEや複数SELECTへフォールバックしない。DB拒否は固定409とし、入力やDBエラーの生内容は返さない。
- 一般受付のON/OFFは変更・照会しない。受付を止めた後も、既存業務の明示的な記録は運営者だけが行える。メール、通知先、送信予算、決済、配車には接続しない。

## 書き込みの契約

全操作に `action`、`request_id`、`operation_id`（UUID）、`expected_order_version`、操作ごとの固定 `confirmation` が必要。未受注の期待版は0、受注後は現在版を指定する。`operation_id` は全相談を通じて一度だけ使用する。DB内の相談行ロック・版照合・操作記録と一体で処理され、クライアントによる事前照会は排他制御の代わりにならない。

| action | 追加項目 | confirmation |
| --- | --- | --- |
| `record_agreement` | `expected_agreement_version`、`amount_yen`、`pickup_at`、`delivery_at`、`customer_confirmed_at`、`confirmation_method`、`conditions`、`confirmation_note` | `RECORD_OBSERVED_CUSTOMER_AGREEMENT` |
| `accept_order` | `agreement_version`（記録した条件版） | `RECORD_OPERATOR_ACCEPTANCE` |
| `apply_agreement` | `agreement_version`（受注後に記録した変更条件版） | `APPLY_RECORDED_AGREEMENT` |
| `change_status` | `next_status`、`note` | `RECORD_DELIVERY_STATE_CHANGE` |

`record_agreement` は、**管理者が実際に確認した顧客の条件合意を業務記録にする操作**。顧客がアプリで認証済み同意を行ったという意味ではない。金額は既存見積もりと同じ1〜10,000,000円の整数。日時は年0001〜9999の4桁年・ミリ秒付きUTCの正規ISO文字列を要求し、年0000・拡張年を拒否する。配送希望日時はnullまたは集荷希望日時以降。確認日時は未来を拒否する。確認方法は `email | phone | in_person | other`。条件30〜1,200文字と確認メモ5〜600文字をJSONごと暗号化し、平文をRPCへ渡さない。税・高速代等の条件は人が個別に記録し、自動判定しない。

`accept_order` は別の管理者操作で、期待受注版0を要求する。`apply_agreement` は既存受注版1以上を要求する。新しい合意記録だけで適用条件を置き換えない。`change_status` の送信値は `preparing | in_transit | completed | cancelled` で、実際に許可される遷移はDBで検証する。配送完了も管理者の明示操作が必要。メモは0〜600文字、中止時は5文字以上を要求して暗号化する。

4操作とも `cargo_customer_order_command` だけを呼び、不要なRPC引数はnullにする。成功時は相談ID、受注版、条件版、状態をホワイトリストで返す。`legal_contract_determined`、`customer_notified`、`payment_created`、`dispatch_created` は常にfalse。この記録で法的な契約成立時点・キャンセル条件・保存期間を確定しない。

タイムアウトや503の後に新しいoperation_idを生成して自動再送しない。読み取りで同じoperation_idの履歴と版を確認し、運営者が処理結果を照合する。履歴照合用のoperation_idは秘密トークンではないが、認証された運営者以外へ返さない。同じoperation_idの重複はDBで拒否する。UIの再送・照合案内は次工程。

## 管理者向け読み取り

`action=read` と `request_id`、任意の `before_agreement_version` / `before_event_sequence`（正の整数）を受け付ける。単一の `cargo_customer_order_read` RPCが相談行を共有ロックし、書き込みと競合しないスナップショットを返す。直接表の複数照会による代替はしない。

受注、合意履歴、状態履歴を返す。履歴は版・通番の降順で最大51行をRPCから取得し、先頭50行だけ検証・復号する。続きがある場合は50行目の値を次の `before_*` として返す。PostgreSQLのオフセット・マイクロ秒付き日時を受け付けるが、リクエスト入力のISO検証は緩めない。

顧客の元申込暗号文や元申込の住所・メール項目、秘密リンク、鍵、DBエラーは返さない。注文に必要な合意条件・確認メモ・操作主体と日時は、認証された運営者にだけ復号して返す。合意条件へ入力した配送情報もこの権限内で扱う。応答は `Cache-Control: no-store`。受注の保存方針は `undetermined_hold`、削除期限はnullのまま表示する。

## 隔離検証

新規テストのみ：

```sh
node --test --test-isolation=none tests/cargo-customer-orders-edge.test.cjs
```

実際のTypeScriptソースをNodeの型除去でVM実行し、Auth・DB RPCだけをmock化する。送信関数は呼ばれたら失敗する。JWT/所属、Origin、サイズ、入力、暗号化・復号、競合応答、RPC欠落、秘密非表示、単一RPCのページングを確認する。DBの真の競合・権限・誤削除防止は別の隔離PostgreSQL試験で確認する。mock試験を本番動作確認とは扱わない。
