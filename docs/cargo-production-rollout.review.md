# 軽貨物受付：本番反映の準備と復旧手順
更新：2026-10-16 19:22 JST。実施計画であり、本番変更・一般受付ON・顧客メール送信の承認ではない。

## 最新の確認結果（2026-10-16 19:20 JST）

**本人限定の検証環境で、実メールを含む顧客用APIの通し確認が完了。** 認証メール→コード確認→暗号化保存→管理者審査→見積もり下書き→見積もりメール→別ブラウザーで本人ログイン→利用希望の回答保存まで成功した。試験は期限でCLOSEDとなり、内部intake_enabled=falseを読取確認した。新たな試験や再送は不要。

これは固定の架空案件・本人宛て各1通・当日希望での結果。本番環境の導入、一般のお客様向けの未ログイン経路、将来日時の実メール検査、不正利用対策・監視、公開条件の確定まで完了したという意味ではない。

## 現在地と工数の見込み
限定した初回公開（配送相談→メール確認→手動審査→手動見積もり→希望回答）の残作業は、約8〜16時間＝1〜2作業日分の暫定見込み。
料金自動計算、契約自動成立、ドライバー配車、Square等の自動決済は含まない。
条件回答待ち、外部サービス審査待ち、新たな不具合修正は別。連続したバックグラウンド作業や特定日の公開を約束するものではない。

| 残作業 | 目安 | 完了条件 |
|---|---:|---|
| 公開案内・契約/料金条件・外部サービスの取扱確認 | 2〜4時間 | 事業者情報、契約成立、キャンセル、税込/税別・実費等が運営者確認済み。保管先・メール履歴の扱いも確定 |
| 本番導入の準備・レビューと承認後の反映 | 3〜6時間 | 下記の対象だけを選択し、移行・設定・権限・復旧手順の確認完了 |
| 不正利用対策・監視・通し確認・修正 | 3〜6時間 | 公開経路の送受信/回答/重複防止、停止動作、異常時の手順が確認済み |

## 本番で確認した差分（読み取りのみ）
- main 基準：3e7f7db4883020f6bed3c1a2dca593f278ae2d8c。実際の反映前に再取得する。
- 顧客用 intake/review/quote-reply ページは main に存在しない。
- 本番 kvoaorzdewwirqryeizq には intake control、operator accounts、rate buckets と rate-hit 関数が存在する。
- 顧客の drafts/requests/quote replies/followups/followup events/retention runs の6テーブルと customer RPC は未導入。
- 検証環境 hvdoqcrnztqmbzgwrovd の所有者固定テストは成功。ただし、その成功を公開顧客経路・実見積もり送受信の成功と同一視しない。

## 反映対象を限定する
公開サイトへの候補：
- cargo-customer-intake.html
- cargo-customer-review.html
- cargo-customer-quote-reply.html
- cargo-pwa/request-review-rules.js（依存先がmainの版と一致するか確認）
- cargo-operator-login.html（既存ログインとの互換性を確認し、必要な差分だけ反映）
- 公開前に確定したプライバシー・契約条件の案内（現時点では文案のみ）

関数と設定：
- cargo-customer-intake：integrations/cargo-customer-intake/index.ts。ログイン前利用の設計として既存の独自認証・受付OFF・Turnstile・OTPを確認した上でJWT設定を決める。
- cargo-customer-review-operator：operator.ts。verify_jwt=true、getUser＋operator membership必須。
- 顧客の見積もり回答関数：quote-reply.ts。秘密トークンHMAC・期限・受付OFFを確認。正確な配備名はフロントのinvoke名と照合する。
- 新規本番用の環境設定は管理画面等の安全な経路で設定し、値をチャット・GitHub・ログに出さない。ステージング鍵をそのまま複製しない。
- 送信元は cargo@mail.rainbow-driver.com を候補とする。Resendアカウント/権限/検証ドメインが本番用キーと一致するか確認。
- 問い合わせ：rainbow.driver.saitama@gmail.com / https://lin.ee/8YNhfM5。ログイン・所有者テスト宛先の変更とは別。

除外：
- staging/ 以下、owner-only test、stage secrets/fixture/owner lookup/recovery のデータとコード
- staging-bootstrap.sql（既存control/operatorを再作成するため本番へ適用しない）
- 運転請負、既存driver画面、CNAME、Square本番、dispatch関連の無関係な差分
- 開発ブランチ全体のマージ

## 実施順（準備済みの設計。まだ本番未実施）
1. production-preflight.review.sql で選択プロジェクトと現状を再確認。顧客データや秘密値を取得しない。
2. 既存mainのSHA、配備済み関数版、対象テーブル/RPC定義、受付スイッチを記録。復旧時に戻す版を特定する。
3. 現在の受付OFFを維持して新しい顧客テーブル/RPCのみ導入する。schema.review.sql → quotes.review.sql → mail-budget.review.sql → followup.review.sql → closed-no-order-retention.review.sql の依存順。各ファイルはレビュー用なので、そのまま無確認で実行せず、本番専用migrationとして内容と権限を固定する。
4. 初回導入のquotes.review.sqlには継続相談の期限修正が含まれる。既存quote RPCの更新環境だけで active-consultation-expiry.review.sql を使う。両方を重複実施する必要はない。
5. RLS/権限、operator所属の実在、service-only RPC、暗号化鍵の有効性、外部サービス設定を確認。管理者画面は所属表を直接参照せず、保護されたAPIのgetUser＋operator所属確認を使う。未所属ユーザーへの一覧拒否を確認する。
6. 関数・サイトの対象差分を反映し、受付OFF状態と未ログイン拒否、ブラウザの参照先、本番/検証環境の混在がないことを確認。
7. 下書き削除、終了案件削除、失敗監視を本番用名で設定。staging用scheduleファイルを無変更で実行しない。作成直後から既存案件を削除対象に推定しない。
8. 公開経路の通し試験は対象・宛先・送信回数を限定した計画を先に作る。受付ONや実メールが必要な段階は明示承認後のみ。所有者専用テストの繰り返しで代替しない。
9. 完了結果と公開条件を確認してから運営者に一般受付開始の判断を求める。未完了がある間は受付OFFを維持。

## 復旧と停止
- 送信不明、重複登録、暗号化復号不良、権限逸脱、環境混在等を検知したら一般受付を停止し、新規送信・見積もり送信を止める。画面を戻すだけでは停止にならない。
- 最初に残っているdraft/request/quoteの状態と、プロバイダーの配信状態を確認する。メールは取り消せないため、自動再送・送信予約の解除をしない。
- サイト/関数は記録した対象版に戻す。旧コードが新しい終了・保留情報を誤処理しないか確認し、必要なら顧客APIを停止したままにする。
- DBは原則として前進修正する。受付済みデータや新テーブルをDROPして戻さない。
- 削除ジョブに疑いがある場合は該当ジョブだけを停止し、保留情報を維持する。暗号化鍵を変更・紛失してもデータは復元しない。
- 復旧後は同じ受信者への重複通知を避け、ログイン制御・受付OFF・データ整合の再確認後に再開判断する。

## 公開判断までに必要な業務情報
- 正式な事業者名・必要な公表事項
- 契約成立の時点と双方の確認方法
- キャンセル条件と連絡方法
- 税区分、高速・駐車・待機・荷役等の扱い
- 本番の保管サービス/取扱国、メール履歴・バックアップ等の保存運用
未回答の内容をシステム側で推測して確定しない。

## 顧客メールの全体送信枠（検証環境に追加）
- mail-budget.review.sql をquoteテーブル/RPCの後に導入する。OTPと見積もり送信を合算する。
- 検証用初期値は時間枠10回・JST暦日50回。これはResendアカウント全体の利用量や無料枠の保証ではない。所有者用テスト送信・他アプリはカウント対象外。
- 本番の件数は運用量と他の送信経路を含めて公開前に確認する。レート制限は予約枠を消費し、失敗・不明時に返還しない。
- RPC/table不在・停止・取得失敗時は送信禁止。枠の確保はDB行ロックで直列化し、見積もりは不可逆な送信claimと同じトランザクションで確保する。
- 新規 cargo_customer_mail_budget を反映候補に追加。個人情報・IP・メールアドレスは保持しない。
- 関数/APIの上限を迂回する他のメール送信経路は別途確認が必要。IPごとの制御・信頼できる接続元ヘッダーの確認は引き続き未完了。

## 反映候補の固定と依存確認（2026-10-15）
- docs/cargo-production-candidate.review.json に画面・共通JS4点、関数3点、SQLレビュー案5点のGit blob SHAを固定。基準ソースは e4435649a18bbb0ff15b0ec7fea7bf579ce5dabb。
- main基準を再取得し、3e7f7db4883020f6bed3c1a2dca593f278ae2d8c と確認。共通JS cargo-pwa/request-review-rules.js はmainに存在せず、画面と同時に追加する必要がある。
- ローカルで `node scripts/check-cargo-production-candidate.cjs` を実行。12点の内容一致、相対リンクの対象範囲、画面内の検証環境参照の混入を検査する。ファイルを改変した場合に拒否する試験も実施済み。
- この一覧はレビュー時点の固定スナップショット。今後ソースを修正したら、内容を再レビューしてSHAを更新する。チェックを通すためだけにSHAを差し替えない。
- 既存リンク先 cargo-operator-login.html / cargo-request-preview.html はmainに存在する。ここでは既存リンク先の全機能の動作を保証しない。既存ログインの権限表ポリシー互換性は反映前に別途確認する。
- manifestは公開許可ではなく、SQLも実行用に確定した本番migrationではない。公開用の案内が完成したら必要なページとリンクを候補へ追加して再検証する。
- 一般受付準備中の表示・プライバシー案内の公開前文言は未完成。正式な事業者情報、契約・キャンセル・費用条件と合わせて公開前に確定する。

## 運営者による画面レビューの段取り
2026-10-15、運営者から「実態が分からず意見を言えていない。技術面は進め、事業判断には参加したい」との意向を確認。日付を優先して公開を急がない。
- 第一回：お客様側の入力→内容確認→認証→受付完了。架空データで、項目の多さ、説明の分かりやすさ、相談窓口を確認。再送テストを求めるレビューではない。
- 第二回：管理者側の一覧→審査→見積もり作成→回答確認。日々の作業順と必要な情報を確認。
- 第三回：見積もり回答・期限切れ・通信エラー。困ったときの連絡先と、配送確定と誤解しない表現を確認。
- 料金、追加費用、キャンセル、契約成立、詳細住所の公開は、具体案をまとめて運営者に確認。未回答を承認としない。
- 伊奈町の詳細住所は掲載しない。集客の地域表示は町名までとする。非公開で提供された住所をGitHub・画面・テストデータに転記しない。
- 見積もり回答ページに指定のメール・LINEの問い合わせ導線を追加。リンクは静的で、認証コードや回答トークンを付加しない。スマートフォンでメールアドレスを折り返す。回答処理のJavaScriptは変更していない。
- 反映候補は de57a09510637144c108ac525f2fd82b18fab337 時点で12ファイルのSHAを再照合済み。本番未反映。表示文言変更に伴う新規送信・DB操作はない。


## 2026-10-15 管理者画面の日本語表示

- 開発版の root/staging 管理者審査ページで準備状況・積み降ろし補助・見積もりメール送信状態を日本語表示へ変更。
- `sent` は到着確認と混同しないよう「送信受付済み」と表示。未知の状態は「要確認」。保存値・API・認証・送信処理は変更していない。
- 両ページの JavaScript 構文検査を実施。表示のみの変更のため新規テスト送信なし。本番公開・一般受付ONなし。
- 別途、実装を基にした通信なしの3画面レビューHTMLをユーザーへ提供済み。管理者操作は簡略デモであり、本番E2E完了の証拠ではない。


## 2026-10-15 公開候補照合のCI組み込み

- Cargo OTP review CIのoffline-security-contractに `node scripts/check-cargo-production-candidate.cjs` を追加。候補一覧・照合スクリプトのみの変更もPR検査対象へ追加。
- 12ファイルの内容ハッシュ・ローカル参照先・検証環境参照の混入を検査。CI成功は公開許可ではない。ブランチ保護の必須チェック設定は変更していない。
- コミット `2c0eb466c17b5e2d499c606241fd6fea9623ed21` の Actions run `38727916594` で新規照合ステップ・既存offlineテスト・隔離Postgresテスト・staging OFF確認が成功。
- 本番デプロイ、一般受付開始、顧客へのメール送信は行っていない。


## 2026-10-15: future pickup time — staging API deployment

- Staging project `hvdoqcrnztqmbzgwrovd` only: `cargo-customer-intake` updated from v12 to v13. Source blob `09521c13d7819a2efba370f032bc6ec70111d3ab`; retrieved deployed source matches exactly.
- Existing `verify_jwt=false` preserved; custom intake gate, Turnstile and OTP checks unchanged. No secrets, schema, operator function or production changes.
- Supports immediate/today or a strictly validated future Japan-local pickup time, retained in encrypted request data. This is a requested time, not a confirmed booking.
- Live verification: status HTTP 200 reports public_intake_enabled=false, accepts_orders=false, automatic_dispatch=false, payment_enabled=false. Payloads containing only action=start or action=verify both return HTTP 423 PUBLIC_INTAKE_DISABLED before writes/mail.
- Customer UI changes remain on the development branch; no public UI deployment in this step. Future-time authenticated live end-to-end flow remains untested; prior local pipeline and CI checks are not a substitute for that launch gate.


## 2026-10-16 反映対象の取り出しと画面検証

- `node scripts/package-cargo-candidate.cjs <repo-root> <new-output-directory>` を追加。事前に既存のSHA・リンク・検証環境混入検査を実行し、候補12点のみを取り出す。既存出力先には上書きしない。
- `site/` は追加候補4点だけであり、既存サイト全体との置換は禁止。既存ログイン等は維持する。関数3点・SQL案5点は公開用ディレクトリと分離し、それぞれレビュー専用と明示する。
- 固定ソースの12点で生成・内容照合が成功。main基準 `3e7f7db4883020f6bed3c1a2dca593f278ae2d8c` は再取得して一致。SQL実行・本番反映・一般受付ONは行っていない。
- 希望日時のスマホ幅ブラウザー検査を既存CIへ追加。コミット `45c9b4fd13f86a2e80c43a0fb17d1714e4573b38`、run `38815530147` 成功。未入力/過去日時拒否、日本時間の確認表示、当日/日時指定切り替え、模擬送信データへの保持を確認。外部通信はすべて模擬応答で、実メールの通し検査とは別。
- 公開用案内、実メールを含む限定通し試験、本番専用migrationの確定、公開判断は引き続き未完了。

## 2026-10-16 14:35 JST以降：画面確認結果と見積もりリンク連携検査

- 運営者がiPhoneで独立した架空画面の申し込み確認・受付表示・管理者審査・下書き・利用希望回答まで操作。変更希望は現時点なし。実送信・DB保存・画面間のデータ引継ぎを確認したものではない。
- 既存HEAD 265da87d81129055ea6667a9b454d8201fae4717のCI3種（security/SQL、customer browser、staging OFF smoke）はすべて成功。
- 新規 tests/cargo-customer-quote-flow.test.cjs は実際のoperator.tsから生成されたメール本文を模擬送信先で受け取り、fragmentリンクを実際のquote-reply.tsに渡す。送信側と回答側のHMAC一致、金額・条件・期限の一致、改変トークン拒否、異なるOrigin拒否、受付OFF拒否、未認証・未所属拒否、二重送信/回答の抑止応答、非契約/非決済フラグを確認。
- 外部fetchは模擬送信だけ。DBのclaim・再使用防止の状態は模擬実装であり、実DBの原子性証明ではない。別の隔離Postgres試験および実環境の送達確認が必要。
- ソースはoperator blob 313c0e5fb3b4ab3c018c79a16837376ae46527ae、reply blob 17a051fa3c06b9e1f907165ded3ba4a649114059と一致。ローカルで新規連携検査成功。CIへ追加した。
- 次の実メール試験案：検証環境の顧客経路で架空案件1件、運営者本人のテスト宛先1つ、認証メール1通＋見積もりメール1通を上限とし、認証→保存→審査→下書き→送信→実リンク→利用希望→管理者表示を確認する。OTPやリンク秘密値はログ・Gitに残さない。不明な送信は再送しない。
- これは実行済み記録ではない。実顧客経路を一般開放せずに試せる制限方法の確定、配備先・リンク先の一致、試験終了時のOFF確認が先決。今回、受付スイッチ・DB・本番配備・実メールは変更していない。

## 2026-10-16 15:04 JST以降：検証メールの戻り先を修正

- 稼働中staging operator v11のメール本文が本番用 /cargo-customer-quote-reply.html を参照し、当該ページが本番APIを参照する不一致を発見。検証用回答ページは開発ブランチにも存在しなかった。
- staging/cargo-customer-quote-reply.html を追加。検証プロジェクトの公開キー・APIのみ使用し、秘密fragmentの除去と既存の非契約/非決済表示を維持。
- 共通operatorコードはSUPABASE_URLが検証プロジェクトと完全一致したときだけ /staging/cargo-customer-quote-reply.html をメールに使用。それ以外は既存の本番パスを維持。宛先やOrigin、認証・権限は変更なし。
- 実送信コード→模擬メール→実回答コードの検査は検証用URLで成功。本番用パスが変わらないことも確認。stagingページの本番参照混入・公開キー・fragment除去をCIへ追加。
- 修正は開発ブランチのみ。稼働中関数・公開HTMLは未配備。両方を対応する版にそろえるまで実メール試験へ進まない。既存stagingはintake_enabled=false/captcha_required=true/contact_verification_required=trueを読取確認。
- 実メール試験には、一般受付を開放せず対象を限定する手段とメール送信範囲の確定が引き続き必要。今回メール送信・データ変更・受付ONなし。

## 2026-10-16 17:51 JST以降：検証用回答経路の配備と実配信照合

- 検証プロジェクト hvdoqcrnztqmbzgwrovd の cargo-customer-review-operator をv11→v12へ更新。verify_jwt=trueを維持。変更はquoteReplyPathとメール本文の参照先のみ。取得した配備ソースはblob 7b651c40a02d33fca9db9bb9fc3bc0ec75d147ceと完全一致。
- staging/cargo-customer-quote-reply.html の戻りリンクを、既存の ../cargo-staging-login.html へ変更。開発ブランチでのblob ff6bf20b0399d4e1517e2cf9a9c2fbca8a0e3853を、mainにこの1ファイルだけ追加（commit 99561046d4dfb39f2c5a795826fbe1a51a99e719）。顧客用本番ページ・他業務・CNAME・本番APIは変更していない。
- GitHub Pages run 38877020249成功。https://app.rainbow-driver.com/staging/cargo-customer-quote-reply.html がHTTP200で応答し、実配信バイトのGit blob SHAもff6bf20b0399d4e1517e2cf9a9c2fbca8a0e3853と一致。検証API参照のみ。
- 配備後のライブ確認：operatorの未ログインlistはHTTP401 LOGIN_REQUIRED、intake statusはHTTP200でpublic_intake_enabled=false/accepts_orders=false/automatic_dispatch=false/payment_enabled=false、架空トークンでのreply viewはHTTP423 PUBLIC_INTAKE_DISABLED。
- controlはintake_enabled=false/captcha_required=true/contact_verification_required=trueを再確認。DB設定変更・メール送信なし。
- 開発修正e795d45657930b3275cf6b3b29fa51264d66824bに対するsecurity/SQL、browser、staging smokeの3CI成功。
- 残る限定通し試験の条件：現状の一般受付スイッチだけをONにすると対象外の開始/回答も許可し得るため、その操作は行わない。本人のみ・架空案件1件・期限付きの試験制限を先に実装/検証し、送信対象と上限が確認できてから実メール2通の試験へ進む。今回の反映を実メールE2E成功とは扱わない。

## 2026-10-16 18:02 JST以降：本人限定・1案件・30分・各1回の試験制限

- stagingの3顧客関数へ同一のサーバー制限を追加。確認済みメールを持つ固定ownerのgetUser検証、固定の架空データ、本人の認証メール宛先、固定draft_idとsource_draft_idで結び付く1件だけを許可する。検証プロジェクト以外ではこの追加制限は適用しない。
- 新規staging専用cargo_staging_owner_test_runsはRLS有効、public/anon/authenticatedの権限を撤回。service_roleだけが行を取得・登録・更新し、認可RPCを実行できる。作成だけでは試験を開始しない。owner固定、最大30分、初期enabled=falseをDB制約で強制。
- 行ロックを使い、OTP送信開始と見積もり送信の枠を各1回だけ確保する。不明な送信でも枠を戻さない。送信直前にも期限・本人・対象を再確認する。
- 期限切れ/無効/取得失敗/本人以外/別宛先/別fixture/別案件は拒否。既存のDB受付スイッチ、Turnstile、OTP、メール全体枠、原子的な回答処理を迂回しない。
- 匿名のstaging status/start/verifyは、内部スイッチを有効とした模擬条件でも公開利用不可。既存の本番処理を対象とした連携試験と、本番/検証メールパスの確認も継続。
- 回答ページに本人ログイン欄を追加。パスワードは送信後に画面から消去し、保存しない。パスワードをURLへ送るHTMLフォームは使わない。回答用秘密fragmentの即時除去を維持。
- コードcommit 2eecc208481488c3309c6f76c51eaaa48dfa6e34、固定manifest 7e286a5d620f44d490bba002c19ae605fb0c028a。mainの既存検証ツールを開発ブランチへ取り込み、回答ページの追加競合は本人確認版で解決。mainへのブランチ全体マージは実施しない。
- 検査対象head 18531c23282298f140aed6d3392c89df6d32c308、security/SQL run38879938532、browser run38879938384、smoke run38879938484が成功。隔離PostgreSQLで権限、owner/対象/期限、再使用拒否、並列start/quoteの各1回claimを確認。外部メールなし。
- 検証プロジェクトにSQL制限のみ導入し、intake v14/verify_jwt=false、operator v13/verify_jwt=true、quote-reply v11/verify_jwt=falseへ配備。3つの配備ソースを取得して完全一致確認。
- 回答ページだけmain更新commit70aa7b6fa1387bacda682061015ece473f95e13b、blob7f46ba997f825138bda99bc62efdf5e98e760990。顧客用本番APIは変更していない。
- 配備後、試験台帳0件、intake_enabled=false、captcha_required/contact_verification_required=true、anon台帳SELECT不可、authenticated認可RPC実行不可を確認。試験枠は作っていない。実メール送信もなし。
- security advisorのRLS有効/ポリシーなしINFOはservice_role専用の閉鎖設計として維持。匿名・ログイン利用者への権限追加で解消しない。既存Authの漏洩パスワード保護WARNは今回変更なし（https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection）。
- 残作業：開始・停止と30分枠の有効化方法、固定fixture/attempt_idで実際の入力→OTP→審査→見積もり送信を行う試験画面への接続。これらが完成する前に内部スイッチをONにしない。本項は実メールE2E成功を示さない。

## 2026-10-16 18:27 JST以降：本人限定メール試験の開始画面まで接続

- staging/cargo-owner-mail-test.htmlを追加。本人ログイン→試験開始（送信なし）→Turnstile→本人宛てOTP1通→コード入力/暗号化保存→審査→金額/条件入力→保存済み内容の確認→本人宛て見積もり1通→メール内リンクで回答→回答結果確認→終了、を操作できる。金額は空欄開始で正式料金を決めない。
- 新規cargo-staging-owner-mail-test関数は検証プロジェクト固定、getUserと確認済みowner UUIDを要求。beginには固定の確認文字列を要求。状態/開始/終了だけを扱い、メール送信処理は持たない。provider等の設定不備では開始しない。
- staging専用session SQLを追加。開始時だけ1件の30分台帳と内部制御スイッチを同一トランザクションで有効化。全顧客APIは既存の強制owner制限で匿名・別ユーザーを拒否するため、一般のお客様への開放にはならない。再度beginしても期限や送信枠をリセットしない。終了/期限後の同じ枠は再開しない。
- finishは台帳と内部スイッチを停止。expire関数は期限切れを停止。検証プロジェクトのcron job3（cargo-staging-owner-mail-trial-expire、毎分）を登録し、画面を閉じても内部スイッチが停止する。メール/認証/回答の許可はguardの期限判定で30分を越えない。
- メールを別ブラウザーで開いたとき、view失敗だけでメモリー内のリンク秘密値を消していた問題を修正。本人ログイン後に再度viewできる。回答の成否不明時は引き続き秘密値を消し、再送/再回答しない。
- 初回CIで、期限停止の観測を関数実行と同じSQL式にした検査コードと、Playwrightのpredicate評価がページCSPに止められる検査コードを修正。配信用CSPは弱めず、外部通信を全遮断した模擬ブラウザー側だけbypassCSPを使用する。
- head8ad5a48093622830f08691f6a6065090a1b8c61bで、security/SQL run38882325398、mobile browser run38882325311、staging smoke run38882325297が成功。新規ブラウザー検査は390px幅で1通ずつ・変更後の送信禁止・別ブラウザーの本人ログイン/秘密fragment除去・回答記録確認・終了を検査。全ネットワークは模擬応答で、実メール到着の証明ではない。
- 検証プロジェクトへsession SQLと新規管理関数v1/verify_jwt=trueを配備。配備ソースはblob557b294867d2ed939e2c8ed515984c8b813bc80fと一致。
- main commit e6d7d128ffd560c9c159b0c9348cdef9ce0eedd8ではstagingのHTML2点だけを反映。Pages run38882622153成功。実配信がHTTP200で、trial画面blob284266139f233691ad089b9281096779a49ec4e4、reply画面blobc99fa75423db014a8c60ace33ed60760153eac3dに一致。本番顧客APIや本番DBの導入はしていない。
- ライブ確認：未ログインの管理APIはHTTP401 LOGIN_REQUIRED。session statusはNOT_STARTED、台帳0件、内部intake_enabled=false、anonのsession RPC実行不可、authenticatedのexpire RPC実行不可。試験はまだ開始せず、実メール0通。
- 次は運営者が https://app.rainbow-driver.com/staging/cargo-owner-mail-test.html で検証用アカウントにログインし、送信なしの開始を行う。認証コードは本人が画面に入力し、チャットやGitへ送らない。メール到着・実DB連携・実リンク回答の最終確認は本人の操作待ち。
- security advisorは既存のservice専用RLS/no-policy INFOと漏洩パスワード保護未有効WARNのみ。一般向け顧客ページ・本番設定の公開判断は引き続き別。

## 2026-10-16 18:49〜19:20 JST：実メール通し確認の完了

- 運営者が試験を開始。request 5985691b-43b7-4a4d-b3b1-8628b9b1a1a9を顧客用の検証テーブルへ保存し、operator_reviewingへ更新した。
- 初回の見積もり保存ではPostgresのマイクロ秒付き期限を、そのままミリ秒精度の正規ISO日時を要求するAPIへ送って拒否される不備を発見。画面でtoISOString()へ正規化する修正を実施。期限を延長しない。mainの検証HTMLだけcommit99638d00de48cbb3600c4ee0ef1448b5d46120ddで反映。
- 実際の保存ハンドラーにPostgres形式の期限を与えるローカル検査成功。模擬ブラウザー試験も同じ形式へ変更し、APIに渡す正規化結果を検査。dev head79fc15fbafa1dc9863fe489aefcc2549fb9abc31でsecurity/SQL run38884835951、browser run38884836019、staging smoke run38884835900が成功。Pages run38884793573成功、配信HTMLでも修正を確認。
- 修正後、運営者が架空の10,000円・テスト条件の下書きを保存し、確認ダイアログから本人宛て見積もりを送信。メールから回答画面を別ブラウザーで開き、本人ログイン後、19:18 JSTに「利用希望を記録しました」の表示を確認した。正式料金の決定ではない。
- 19:20 JSTの読取結果：trial.state=CLOSED、reply_state=interested、delivery_status=sent、request_status=quoted、start_claimed=true、quote_claimed=true、intake_enabled=false。期限停止と回答の永続化を確認。認証コード・暗号化内容・リンク秘密値は取得/記録していない。
- 配送・契約・配車・決済は作成していない。本人宛て試験メールの再送・枠リセット・旧テスト削除は行わない。
- 次の作業は公開前の表示整理、運用上の監視/停止手順、本番導入対象のレビュー。料金表・税/追加費用・キャンセル・引受け条件などの事業判断は未確定として維持する。

## 2026-10-16 19:35 JST以降：読取専用の監視判定

- staging-monitor.readonly.sqlとcheck-cargo-monitor.cjsを追加。個人情報・秘密値・配信エラー本文を取得せず、送信不明/10分超の送信中、15分超の下書き削除遅延、期限停止漏れ、保護設定、3つの定期処理の停止/設定差/成功の遅延/最終成功後の失敗を判定する。
- 実際の検証環境へSELECTのみ実行し、その結果を判定スクリプトへ渡して正常を確認。19:35 JST、異常件数すべて0、内部受付OFF、3ジョブ稼働/予定一致/成功履歴あり。新しいテーブル・権限・関数・cronは作成していない。
- 通常/異常/古い結果/設定欠落/入力不正の5ローカル試験が成功。隔離PostgreSQLのcron模擬履歴でSQLから分類までの正常・欠落・遅延・失敗・復旧検査をCIへ追加。試験の書込みは隔離DB内でロールバックする。
- 本番監視、定期起動、通知連携は未導入。監視間隔/通知先/障害担当/本番ジョブ名は別途レビュー。スクリプトは送信・再送・削除・修復を行わない。手順と限界はdocs/cargo-monitoring.review.md。

## 2026-10-16 19:56〜20:00 JST：検証環境の定期監視を稼働

- staging_bounded_cargo_health_monitorを検証環境だけに適用。監視結果をservice専用/RLS有効の1行へ保持する。snapshot/tickはSECURITY INVOKER、anon/authenticatedは参照・実行不可。
- 監視対象の値だけを読み、日時/異常コード/件数/失敗回数を更新する。メール送信・再送・受付変更・削除は行わない。検査失敗はエラー本文を残さずMONITOR_CHECK_FAILEDとして記録する。
- job4 cargo-staging-health-monitorを5分間隔で登録。同名ジョブの上書きを拒否。20:00 JSTのscheduled runがsucceeded、監視時刻更新・異常なし・内部受付OFFを読取確認した。
- 1c3a5fad1e4b47007ee6ac84f4c3f6b50e33a846のsecurity/SQL run38890342397、browser run38890342399、smoke run38890342609が成功。SQL/Node分類一致、権限、失敗回数、復旧、監視処理自体の失敗を隔離DBで検証。
- 外部からの死活監視・通知、実際の公開経路の不正利用対策、本番導入と事業条件確認は未完了。古い正常記録を正常と判断せず、最終確認時刻の鮮度とジョブ自身の停止も確認する。手順はdocs/cargo-monitoring.review.md。

## 2026-10-17：本番初回導入用SQLの検証完了

- 対象の生成済みSQL blob：`14219afecf1f2dd392c3d8fb5e321c9fbf64db74`（ソースhead `6b5adae58c05855bfb3c232935959f39af0b7346`）。本番未実行。
- CI：security/SQL `38892282167`、browser `38892282118`、staging smoke `38892282252`がすべて成功。
- 隔離DBで6ケース成功：保護された受付OFFでの初回導入、受付ON拒否、保護設定無効時の拒否、既存テーブルの保護、既存顧客関数の保護、途中エラーによる全体ロールバック。初回導入後の再実行も拒否する。既存operator行が保持されることも確認した。
- 2026-10-17の本番読取：protected_off=true、operator_present=true、service_roleのcontrol SELECT/UPDATEとoperator SELECT=true、顧客用7テーブル0件、顧客関数0件。初回導入ガードの前提に一致する。
- 次に確認する実行範囲：本番プロジェクト `kvoaorzdewwirqryeizq` へこのSQLだけを1トランザクションで適用し、空の顧客用保存先と関連処理を追加。内部受付はOFF、メール全体枠は無効のまま、既存コアの行・運転請負・決済・ドメインを変更しない。顧客API/画面/秘密値/cronの配備や受付開始は含めない。
- 本番へ初めてデータベース変更を加える工程のため、この具体的な反映範囲を運営者へ提示して確認する。承認後も直前の状態再取得、SQLハッシュ照合、適用後のRLS/権限/OFF/枠無効/空テーブル確認を行う。今回の準備を一般受付開始の承認に読み替えない。

詳細はdocs/cargo-production-install.review.md。読取と準備のみで本番変更は行っていない。
