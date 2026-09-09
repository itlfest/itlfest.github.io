# CoeFont KDS Worker

KDS の呼び出し番号を CoeFont 音声へ変換する Cloudflare Worker です。アクセスキーとアクセスシークレットは、GitHub Pages や Git リポジトリに保存しません。

## 初回設定

1. Cloudflare にログインして Wrangler を認証する。
2. このディレクトリで `npx wrangler secret put COEFONT_ACCESS_KEY`、`npx wrangler secret put COEFONT_ACCESS_SECRET`、`npx wrangler secret put COEFONT_ID` を実行し、それぞれの値を入力する。
3. `wrangler.toml` の `ALLOWED_ORIGIN` が KDS を公開するオリジンと一致していることを確認する。
4. `npx wrangler deploy` を実行する。
5. デプロイ結果の Worker URL を `kds/customer/coefont-config.js` の `coefontProxyUrl` に設定する。

Worker は番号の配列しか受け付けず、読み上げ文はサーバー側で固定しています。CoeFont が失敗した場合、表示画面はブラウザ標準音声へ自動でフォールバックします。
