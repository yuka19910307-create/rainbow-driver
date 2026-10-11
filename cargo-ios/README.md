# Rainbow Driver 軽貨物 — iPhone専用ドライバーアプリ試作

## 対象
埼玉県伊奈町を拠点とする軽貨物ドライバー1人用の実験版。既存の**お客様の車を運転する** Rainbow Driver 本番アプリとは独立しています。配送予約機能は作りません。

## 現在の機能
- 稼働ステータス（端末内のみ）
- 前景GPSの取得と推定精度表示
- iOSバックグラウンド位置更新タスクの登録と停止
- 画面復帰後の測位更新回数・最終受信時刻の確認
- 位置が古い場合の表示
- 休憩・オフライン操作時の測位停止
- GPSはサーバーへ送信しない。正確な緯度経度も保存しない。端末内の非暗号化ストレージに記録するのは**最終更新日時・測位精度・イベント数**のみ
- ユーザーの「常に許可」（Always）が必要。終了・権限撤回・OSの制限で更新が止まる場合がある

## iPhoneだけで進める手順
- 開発コードの保管先: このGitHubリポジトリの \`cargo-ios/\`。
- Expo（https://expo.dev/）アカウントと Apple Developer Program があれば、Macを使わず EAS BuildクラウドでiPhone用ビルドを作成可能。
- Expo Goでは通常の画面や前景GPSのみ試せるが、**iOSバックグラウンド位置測位は動かない**。EAS Buildで署名された専用ビルドが必要。
- EAS CLIを利用できるクラウド開発環境で \`cd cargo-ios && npm install && npx expo-doctor && npx eas-cli@latest login && npx eas-cli@latest init && npx eas-cli@latest build --platform ios --profile preview\` を実行する。
- Appleの署名（有料Apple Developer Program）と実機登録が必要。**いまは契約・費用発生の操作を行っていない。**
- "preview" は開発サーバー不要の内部配布ビルドとして用意した。iPhoneのSafariからEASビルドのインストールリンクで入手し、実際に他アプリを開いて数分後に戻り、受信回数と最終更新時刻を確認する。

## 検証項目
1. 「受付可能」→「稼働開始」→ iOSの「このAppの使用中」と「常に許可」を承認
2. 前景で計測時刻と精度が表示される
3. Google Mapsナビなど別アプリを数分使用後に戻り、更新時刻や受信回数が進んでいることを確認
4. 「休憩中」か「オフライン」で稼働停止し、それ以降は背景位置更新されないことを検証
5. 権限を拒否・通信圏外・省電力モード・長時間静止・アプリの強制終了時の違いを確認
6. アプリのGPSを使って**自動受注や顧客への正確な位置の開示は絶対に行わない**。サーバー側検証と認証が実装されるまでは試作のみ。

## 備考
本コードは静的レビュー用としてGitHubへ保存した試作であり、**iPhoneネイティブアプリのビルド・署名・インストール実行はまだ**です。端末でのバックグラウンド動作を保証していません。

SDK 58 / React 19.3 / React Native 0.88 を採用。 \`npm install\` で生成される \`package-lock.json\` をコミットして依存関係を固定してください。バージョン整合性は \`npx expo-doctor\` / \`npx expo install --check\` で確認してください。

参考: https://docs.expo.dev/versions/v58.0.0/sdk/location/ ; https://docs.expo.dev/build/setup/
