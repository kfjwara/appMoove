# appMoove 専用 CORS プロキシ（Cloudflare Worker）

appMoove の「URLから取り込み」は、cobalt というサービスに動画のURLを渡して、
動画ファイルを受け取っています。ところが cobalt はブラウザ（iPhone の Safari）からの
直接の読み取りを許可していないため、間に「中継役（プロキシ）」が必要です。

このフォルダは、その中継役を **自分の Cloudflare アカウント上に無料で置く** ためのものです。

- 中継するのは **appMoove のサイトから来た通信だけ**、行き先も **許可した cobalt のサーバーだけ** です。
  （誰でも使える「オープンプロキシ」にはなりません）
- パスワードなどの秘密情報は一切含まれていません。

---

## いちばん簡単な方法：ダッシュボードにコードを貼り付ける（おすすめ）

パソコンのブラウザで作業します（5〜10分）。

1. https://dash.cloudflare.com/ にログインする。
2. 左メニューの **「Workers & Pages」**（または「コンピューティング」→「Workers & Pages」）を開く。
3. **「作成」**（Create）ボタン → **「Worker」** → **「Hello World」から開始**（Start with Hello World）を選ぶ。
4. 名前を `appmoove-proxy` にして **「デプロイ」**（Deploy）を押す。
   （この時点ではサンプルの「Hello World」が動いているだけです）
5. **「コードを編集」**（Edit code）を押す。
6. 左側のファイル `worker.js` の中身を **全部消して**、このフォルダの
   [`worker.js`](./worker.js) の中身を **全部コピーして貼り付ける**。
7. 右上の **「デプロイ」**（Deploy）を押す。
8. 画面上部などに表示される URL を控える。こんな形です:

   ```
   https://appmoove-proxy.<あなたのサブドメイン>.workers.dev
   ```

これで完成です。許可リストはコードの中に初期値が入っているので、
**cobalt のサーバーを変えない限り、設定の追加作業は不要** です。

### 動作確認（任意）

ブラウザで上の URL をそのまま開くと `forbidden origin` と表示されます。
これは「appMoove 以外からのアクセスは断る」設定が効いている証拠なので、正常です。

---

## appMoove 側の設定

1. iPhone で appMoove を開く。
2. 「URLから取り込み」の **詳細設定** を開く。
3. **「CORSプロキシ」** 欄に、控えた URL の **末尾に `/` を付けて** 入力する:

   ```
   https://appmoove-proxy.<あなたのサブドメイン>.workers.dev/
   ```

4. **「保存」** を押す。

アプリは cobalt への問い合わせと動画ファイル本体のダウンロードの両方をこのプロキシ経由で行います。
（cobalt には `alwaysProxy` を指定しているので、ダウンロード先は常に cobalt 自身のホストになります）
この欄が空のまま「URLから取り込み」を使うと、設定を促す案内が出ます。

---

## cobalt のサーバーを差し替えるとき（許可リストの変更）

詳細設定の「cobalt API」を別のサーバーに変えた場合は、そのサーバーのホスト名
（`https://` と末尾の `/` を除いた部分。例: `cobalt.example.com`）を許可リストに足します。

1. Cloudflare ダッシュボード → Workers & Pages → `appmoove-proxy` を開く。
2. **「設定」**（Settings）→ **「変数とシークレット」**（Variables and Secrets）→ **「追加」**。
3. 種類は「テキスト」、名前を `ALLOWED_HOSTS`、値をカンマ区切りで入力して **デプロイ**:

   ```
   api.cobalt.liubquanti.click,cobalt.example.com
   ```

- 変数を一度でも設定すると、コード内の初期値ではなく **変数の値だけ** が使われます
  （なので元のサーバーも残したいなら一緒に書く）。
- 呼び出し元サイトを変えたいときは同様に `ALLOWED_ORIGINS` を設定します
  （初期値: `https://kfjwara.github.io,http://localhost:*,http://127.0.0.1:*`）。
- cobalt サーバーによっては、ダウンロード用URLが別のホスト名を指すことがあります。
  取り込みが「target host not allowed: ○○」で失敗したら、その ○○ も `ALLOWED_HOSTS` に足してください。
- `*`（全部許可）は安全のため効かないようにしてあります。

---

## 補足：wrangler（コマンド）でデプロイする方法

Node.js が入っているパソコン向けです。PowerShell で:

```powershell
cd <appMoove フォルダの場所>\proxy   # 例: cd $HOME\Desktop\appMoove\proxy
npx wrangler login      # ブラウザが開くので Cloudflare にログインして許可
npx wrangler deploy     # wrangler.toml の設定でデプロイ
```

最後に表示される `https://appmoove-proxy.<サブドメイン>.workers.dev` が URL です。
この方法では許可リストは [`wrangler.toml`](./wrangler.toml) の `[vars]` で変更し、もう一度 `npx wrangler deploy` します。

> ダッシュボードで変数を手で設定した後に wrangler でデプロイすると、
> wrangler.toml の内容で上書きされます。どちらか片方の方法に揃えるのが無難です。

---

## 無料プランでの目安

- 1日 100,000 リクエストまで（1本の取り込みで2〜3リクエスト程度なので、個人利用なら十分）。
- ダウンロード時間・ファイルサイズの上限はありません（通信が続く限り流し続けます）。
- ただし cobalt 側のサーバーにも回数制限があります（例: 3分で5回、1日100回）。
