# organizer-bot

GitHub の組織の運用を手伝う GitHub App の bot です。Philtz の組織では philtz-organizer-bot として動いています。Cloudflare Worker で動き、次のことを行います。

- PR に `merge` ラベルが付くと、PR を squash でマージする
- Issue と PR のタイトルと本文を、組織の書式の規約で検査する
- Issue、PR、コメントからツールが付けたフッターを取り除く
- 書式の検査器と規約を、組織のスキルのリポジトリの conventions スキルに写す
- 毎日、日本時間の 7 時 30 分に、組織のプロフィールに出す統計のグラフを作り直す

## 中身

| 場所 | 中身 |
|---|---|
| `apps/organizer-bot` | Worker |
| `packages/conventions` | 書式の検査器。Worker、手元の commit-msg hook、Actions の検査が使う |
| `.github/workflows/conventions.yml` | ほかのリポジトリから呼べる、書式の検査の workflow |

書式の規約の正本は、このリポジトリではなく、組織の `.github` リポジトリの `conventions.yml` にあります。`packages/conventions/fixtures/conventions.yml` は、テストのための写しです。

組織に固有の値は、コードに書かず Worker の環境変数で受け取ります。一覧は `apps/organizer-bot/src/config.ts` にあります。

## マージの流れ

1. webhook の署名を確かめ、PR に `merge` ラベルが付いたイベントだけを受ける
2. PR が開いていて Draft でないこと、タイトルと本文が規約に合っていること、同じリポジトリのブランチであること、PR の head がブランチの先頭と同じこと、デフォルトブランチに追いついていること、必須の検査が通っていること、ruleset が求める数の承認があることを確かめる。必須の検査が決まっていないリポジトリでは、PR の head に付いた検査、workflow の実行、commit status の全部が終わって通っていることを確かめる。bot は ruleset の例外としてマージするので、承認の条件も bot が確かめる。ラベルを付けた人が組織の owner なら、承認の条件は確かめない
3. 変更したファイルと、そのリポジトリの `.github/conventions.yml` から scope を決める。ファイルがなければ組織の `.github` の `conventions.yml` を使う
4. GitHub の Async Merge API で、squash のマージを頼む。件名は `merge(scope): 説明`、本文は空にする。PR の head の sha を渡すので、頼んだあとに push されたら GitHub が取り消す。author は PR を出した人、committer は GitHub になり、GitHub の鍵で署名される。PR のブランチは書き換えないので、途中のコミットは PR に残る
5. GitHub がマージを終えるのを少し待つ。終われば `merge` ラベルと、前に断ったコメントを消す。待ちきれなければ、PR がマージされたイベントを受けて同じように片付ける

2 で条件を満たさないとき、GitHub がマージを受け付けなかったとき、途中で失敗したときは、理由を PR にコメントしてラベルを外します。

### ラベルを付けても何も起きないとき

ラベルが付いたまま、1 分たってもマージもコメントもされないときは、GitHub から Worker への配信が失敗しています。GitHub は失敗した配信を自動では再送しません。ラベルを外して付け直すと、もう一度配信されます。

配信の結果は、GitHub App の設定の画面の Advanced で見られます。そこから同じ配信を再送することもできます。

## 書式を検査する流れ

1. PR が開かれたか、編集されたか、push されたイベントと、Issue が開かれたか編集されたイベントを受ける。閉じたものは検査しない
2. そのリポジトリの `.github/conventions.yml` で、タイトルと本文を検査する。ファイルがなければ組織の `.github` の `conventions.yml` を使う。フッターはボットが取り除くので、取り除いたあとの本文で検査する
3. PR なら、先頭のコミットに `organizer-bot/conventions` のステータスを付ける
4. 違反があれば、内容を 1 つのコメントにまとめる。すでにあれば書き直し、直ったら消す

違反のある PR は、`merge` ラベルを付けてもマージしません。Issue の作成は止められないので、コメントで知らせるだけです。

## フッターを取り除く流れ

1. Issue、PR、コメントが作られたか編集されたイベントを受ける
2. そのリポジトリの `.github/conventions.yml` の `footers` の形に当たる部分を本文から取り除き、本文を書き直す。ファイルがなければ組織の `.github` の `conventions.yml` を使う
3. `deleted_bot_comments` に挙げた bot のコメントは、丸ごと消す

書き直すと編集のイベントがもう一度届きますが、そのときはフッターがないので何もしません。コメントの名前の横に出る「with Claude」は、どの App を通して投稿したかの記録で、本文ではないので消せません。

## 準備

GitHub App を作り、組織に入れたうえで、次を用意します。Philtz の組織では、App と鍵と環境変数は philtzjp/pulumi が用意して届けます。

### 1. App の権限と webhook

App の設定の画面で、次のように変えます。

| 項目 | 値 |
|---|---|
| Webhook の Active | 入れる |
| Webhook URL | `https://<WORKER_DOMAIN>/webhook` |
| Webhook secret | `openssl rand -hex 32` で作った値 |
| Repository の Contents | Read and write |
| Repository の Pull requests | Read and write |
| Repository の Checks | Read-only |
| Repository の Commit statuses | Read and write |
| Repository の Issues | Read and write |
| Subscribe to events | Pull request、Issues、Issue comment |

### 2. 秘密鍵を PKCS#8 に変える

Worker の Web Crypto は PKCS#8 の鍵しか読めません。GitHub が発行する鍵は PKCS#1 なので、変換してから secret に入れます。

```sh
openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
```

### 3. Worker の secret

Worker のアカウントにログインした状態で、次を実行して値を入れます。値はコマンドの引数に書かず、聞かれたときに入れます。

```sh
pnpm --filter @philtz/organizer-bot exec wrangler secret put GH_APP_ID
pnpm --filter @philtz/organizer-bot exec wrangler secret put GH_APP_PRIVATE_KEY
pnpm --filter @philtz/organizer-bot exec wrangler secret put GH_WEBHOOK_SECRET
```

### 4. デプロイの値

デプロイの手順は、composite action の `.github/actions/deploy-worker` にあります。呼んだ側の job が自分の Environment の variable と secret を入力として渡すので、組織の鍵はその組織のリポジトリに置きます。ほかの組織の鍵をこのリポジトリに置かないでください。再利用 workflow にしないのは、呼ばれた側から呼んだ側の Environment の secret を読めないためです。

| 組織 | App | 呼ぶリポジトリ | Environment |
|---|---|---|---|
| philtzjp | philtz-organizer-bot | philtzjp/organizer-bot の `deploy` | `cloudflare` |
| osaxyz | osaxyz-organizer-bot | osaxyz/organizer-bot | `cloudflare` |

philtzjp の分は、main に Worker か検査器の変更が入ると `deploy` がデプロイします。

組織を足すときは、その組織にリポジトリと Environment を作り、そのリポジトリの workflow から次のように呼びます。`ref` を省くと main をデプロイします。

```yaml
jobs:
    deploy:
        runs-on: ubuntu-latest
        environment: cloudflare
        steps:
            - uses: philtzjp/organizer-bot/.github/actions/deploy-worker@main
              with:
                  cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
                  cloudflare-account-id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
                  worker-domain: ${{ vars.WORKER_DOMAIN }}
                  organization: ${{ vars.ORGANIZATION }}
                  bot-login: ${{ vars.BOT_LOGIN }}
                  bot-user-id: ${{ vars.BOT_USER_ID }}
                  conventions-repository: ${{ vars.CONVENTIONS_REPOSITORY }}
                  checker-repository: ${{ vars.CHECKER_REPOSITORY }}
```

Environment には次を入れます。

| 種類 | 名前 | 値 |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Workers の Editor の権限を持つ Cloudflare の token |
| variable | `CLOUDFLARE_ACCOUNT_ID` | Worker を置く Cloudflare のアカウントの ID |
| variable | `WORKER_DOMAIN` | webhook を受けるドメイン。任意で、なければ `organizer-bot.<アカウントのサブドメイン>.workers.dev` で受ける |
| variable | `ORGANIZATION` | 組織の login |
| variable | `BOT_LOGIN` | App の slug |
| variable | `BOT_USER_ID` | bot のユーザーの ID |
| variable | `CONVENTIONS_REPOSITORY` | 規約の正本のリポジトリ。`<owner>/.github` |
| variable | `CHECKER_REPOSITORY` | このリポジトリ。`<owner>/organizer-bot` |
| variable | `SKILLS_REPOSITORY` | conventions スキルを置くリポジトリ。任意で、なければ conventions スキルを写さない |
| variable | `PROFILE_REPOSITORY` | 統計の画像を置くリポジトリ。任意で、なければ統計のグラフを作らない |
| variable | `STATS_EXCLUDED_REPOSITORIES` | 統計から外すリポジトリの名前。カンマで区切る |

## webhook の secret を入れ替える

secret が漏れたおそれがあるときや、Worker と App の secret が食い違ったときに入れ替えます。新しい値を作り、Worker と App の両方に入れます。値は画面にも入力欄にも出さず、一時的なファイルを通して渡します。

App の設定を API で変えるには、App の秘密鍵で作った JWT が要ります。準備の 2 で作った PKCS#8 の鍵を `app.pkcs8.pem` として手元に置き、`apps/organizer-bot` で次を実行します。

```sh
umask 077
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
openssl rand -hex 32 | tr -d '\n' > "$d/secret"
pnpm exec wrangler secret put GH_WEBHOOK_SECRET < "$d/secret"
jwt=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; import { createAppJwt } from "./src/github.ts"; console.log(await createAppJwt(process.argv[2], readFileSync(process.argv[1], "utf8")))' app.pkcs8.pem "$APP_ID")
jq -n --rawfile secret "$d/secret" '{secret: $secret}' \
  | curl -sS -X PATCH https://api.github.com/app/hook/config \
    -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" --data @- \
  | jq '{url, secret_set: (.secret != null)}'
```

`APP_ID` には GitHub App の App ID を入れておきます。最後に `secret_set` が `true` と出れば、App 側にも入っています。

入れ替えたあとは、App の設定の画面の Advanced で、新しい配信の応答が 202 になっていることを確かめます。401 になっていれば、Worker と App の secret が食い違っています。
