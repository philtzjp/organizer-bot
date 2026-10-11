import { checkConventions, type CheckTarget } from "./check.ts"
import { configure, config, splitRepository, type ConfigEnv } from "./config.ts"
import { cleanFooters, type FooterTarget } from "./footers.ts"
import { botCommitter, createInstallationRequest, createOrganizationRequest, type GitHubRequest } from "./github.ts"
import { advanceDefaultBranch, deleteRefusals, merge_label, mergePullRequest, removeMergeLabel, reportRefusal, type MergeRequest, type PullRequestTarget } from "./merge.ts"
import { collectStats } from "./stats-collect.ts"
import { publishFiles, stats_message } from "./stats-publish.ts"
import { renderStats } from "./stats-render.ts"
import { isConventionsSource, syncConventionsSkill } from "./skill-sync.ts"
import { verifySignature } from "./webhook.ts"

export type Env = ConfigEnv & {
    GH_APP_ID: string
    // PKCS#8 の形にした秘密鍵
    GH_APP_PRIVATE_KEY: string
    GH_WEBHOOK_SECRET: string
}

// 使うのは waitUntil だけなので、Workers の型を入れずにここで書く
type ExecutionContext = {
    waitUntil(promise: Promise<unknown>): void
}

export type WebhookEvent = {
    action: string
    installation: { id: number }
    sender: { login: string }
    repository: { name: string, owner: { login: string } }
    label?: { name: string }
    pull_request?: {
        number: number
        state: string
        title: string
        body: string | null
        user: { login: string }
        head: { sha: string }
        base: { ref: string }
        labels: { name: string }[]
    }
    issue?: { number: number, state: string, title: string, body: string | null, user: { login: string } }
    comment?: { id: number, body: string | null, user: { login: string } }
}

// 受けるイベント。App の設定で、この 3 つを購読する
export const handled_events = ["pull_request", "issues", "issue_comment"]

const handleLabeled = async (request: GitHubRequest, event: WebhookEvent): Promise<void> => {
    const target: MergeRequest = {
        owner: event.repository.owner.login,
        repository: event.repository.name,
        number: event.pull_request!.number,
        labeled_by: event.sender.login,
    }
    try {
        const result = await mergePullRequest(request, target)
        if (result.pushed) {
            console.log(`${target.owner}/${target.repository}#${target.number} のブランチを ${result.sha} まで進めた。synchronize を待つ`)
        } else {
            await reportRefusal(request, target, result.reasons)
        }
    } catch (error) {
        console.error(`${target.owner}/${target.repository}#${target.number} のマージに失敗した`, error)
        await reportRefusal(request, target, ["bot の処理が途中で失敗した。Worker のログを確かめる"])
    }
}

// ボットが PR のブランチを進めたことが GitHub に反映されたら、main を進める
const handleSynchronize = async (request: GitHubRequest, event: WebhookEvent): Promise<void> => {
    const pull_request = event.pull_request!
    const target: PullRequestTarget = {
        owner: event.repository.owner.login,
        repository: event.repository.name,
        number: pull_request.number,
    }
    try {
        const result = await advanceDefaultBranch(request, target, pull_request.base.ref, pull_request.head.sha)
        if (result.status === "advanced") {
            console.log(`${target.owner}/${target.repository}#${target.number} を ${result.sha} でマージした`)
            await removeMergeLabel(request, target)
            // 前に断ったコメントは、マージできたので消す。消せなくてもマージの処理は止めない
            await deleteRefusals(request, target).catch((error: unknown) => {
                console.error(`${target.owner}/${target.repository}#${target.number} の断ったコメントを消せなかった`, error)
            })
            if (isConventionsSource(target.owner, target.repository)) {
                await syncSkill(request)
            }
        } else if (result.status === "refused") {
            await reportRefusal(request, target, result.reasons)
        }
    } catch (error) {
        console.error(`${target.owner}/${target.repository}#${target.number} のマージに失敗した`, error)
        await reportRefusal(request, target, ["bot の処理が途中で失敗した。Worker のログを確かめる"])
    }
}

// synchronize のうち、merge ラベルが付いた PR にボット自身が push したものだけを扱う
export const isMergeSynchronize = (name: string, event: WebhookEvent): boolean =>
    name === "pull_request"
    && event.action === "synchronize"
    && event.sender.login === botCommitter().name
    && (event.pull_request?.labels ?? []).some((label) => label.name === merge_label)

// フッターを取り除く対象を、イベントから取り出す。対象がなければ undefined を返す
export const readFooterTarget = (name: string, event: WebhookEvent): FooterTarget | undefined => {
    if (!["opened", "created", "edited"].includes(event.action)) {
        return undefined
    }
    const base = { owner: event.repository.owner.login, repository: event.repository.name }
    if (name === "issues" && event.issue !== undefined) {
        return { ...base, kind: "issue", id: event.issue.number, body: event.issue.body ?? "", author: event.issue.user.login }
    }
    if (name === "pull_request" && event.pull_request !== undefined) {
        return { ...base, kind: "pull_request", id: event.pull_request.number, body: event.pull_request.body ?? "", author: event.pull_request.user.login }
    }
    if (name === "issue_comment" && event.comment !== undefined) {
        return { ...base, kind: "comment", id: event.comment.id, body: event.comment.body ?? "", author: event.comment.user.login }
    }
    return undefined
}

// 規約で検査する対象を、イベントから取り出す。閉じたものは検査しない
export const readCheckTarget = (name: string, event: WebhookEvent): CheckTarget | undefined => {
    const base = { owner: event.repository.owner.login, repository: event.repository.name }
    const pull_request = event.pull_request
    if (name === "pull_request" && pull_request !== undefined && ["opened", "edited", "reopened", "synchronize"].includes(event.action) && pull_request.state === "open") {
        return { ...base, kind: "pull_request", number: pull_request.number, title: pull_request.title, body: pull_request.body ?? "", head_sha: pull_request.head.sha }
    }
    const issue = event.issue
    if (name === "issues" && issue !== undefined && ["opened", "edited", "reopened"].includes(event.action) && issue.state === "open") {
        return { ...base, kind: "issue", number: issue.number, title: issue.title, body: issue.body ?? "" }
    }
    return undefined
}

const handle = async (env: Env, name: string, event: WebhookEvent): Promise<void> => {
    const request = await createInstallationRequest(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, event.installation.id)
    if (name === "pull_request" && event.action === "labeled" && event.label?.name === merge_label) {
        await handleLabeled(request, event)
        return
    }
    if (isMergeSynchronize(name, event)) {
        await handleSynchronize(request, event)
        return
    }
    const footer_target = readFooterTarget(name, event)
    if (footer_target !== undefined) {
        const result = await cleanFooters(request, footer_target)
        if (result !== "unchanged") {
            console.log(`${footer_target.owner}/${footer_target.repository} の ${footer_target.kind} ${footer_target.id} のフッターを処理した: ${result}`)
        }
    }
    const check_target = readCheckTarget(name, event)
    if (check_target !== undefined) {
        const violations = await checkConventions(request, check_target)
        if (violations.length > 0) {
            console.log(`${check_target.owner}/${check_target.repository} の ${check_target.kind} ${check_target.number} に規約の違反が ${violations.length} 件ある`)
        }
    }
}

// 書式の検査器と規約を conventions スキルに写す。失敗してもマージの処理は止めず、毎日の cron でもう一度写す
const syncSkill = async (request: GitHubRequest): Promise<void> => {
    try {
        const result = await syncConventionsSkill(request)
        console.log(result.status === "committed" ? `conventions スキルを ${result.sha} で更新した: ${result.changed.join(", ")}` : "conventions スキルは変わっていない")
    } catch (error) {
        console.error("conventions スキルの更新に失敗した", error)
    }
}

// 週に 1 回、組織のプロフィールの統計のグラフを作り直し、config.profile_repository の images にコミットする
const updateProfileStats = async (env: Env): Promise<void> => {
    const request = await createOrganizationRequest(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, config.organization)
    const files = renderStats(await collectStats(request, config.organization))
    const result = await publishFiles(request, { ...splitRepository(config.profile_repository), branch: "main", directory: "images", message: stats_message }, files)
    console.log(result.status === "committed" ? `統計のグラフを ${result.sha} で更新した: ${result.changed.join(", ")}` : "統計のグラフは変わっていない")
}

// cron の式。wrangler.jsonc の triggers.crons と同じにする。どちらも日本時間の 0 時
// 統計は全リポジトリを読み、変われば組織のプロフィールのリポジトリにコミットするので週に 1 回にする
export const stats_cron = "0 15 * * SUN"
// conventions スキルの写しはマージのときにも動くので、cron は取りこぼしの保険。軽いので毎日にする
export const skill_cron = "0 15 * * *"

export const scheduledTasks = (cron: string): ("stats" | "skill")[] =>
    cron === stats_cron ? ["stats"] : cron === skill_cron ? ["skill"] : []

export default {
    async scheduled(controller: { cron: string }, env: Env, context: ExecutionContext): Promise<void> {
        configure(env)
        const tasks = scheduledTasks(controller.cron)
        if (tasks.includes("stats")) {
            context.waitUntil(updateProfileStats(env).catch((error: unknown) => {
                console.error("統計のグラフの更新に失敗した", error)
            }))
        }
        if (tasks.includes("skill")) {
            context.waitUntil(createOrganizationRequest(env.GH_APP_ID, env.GH_APP_PRIVATE_KEY, config.organization).then(syncSkill).catch((error: unknown) => {
                console.error("conventions スキルの更新に失敗した", error)
            }))
        }
    },

    async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
        configure(env)
        const url = new URL(request.url)
        if (url.pathname !== "/webhook") {
            return new Response("Not Found", { status: 404 })
        }
        if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } })
        }
        const body = await request.text()
        if (!await verifySignature(env.GH_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256"))) {
            return new Response("Unauthorized", { status: 401 })
        }
        const name = request.headers.get("x-github-event") ?? ""
        if (!handled_events.includes(name)) {
            return new Response(null, { status: 204 })
        }
        // GitHub は webhook に 10 秒以内の応答を求めるので、先に応答してから処理を進める
        context.waitUntil(handle(env, name, JSON.parse(body) as WebhookEvent).catch((error: unknown) => {
            console.error(`${name} のイベントの処理に失敗した`, error)
        }))
        return new Response(null, { status: 202 })
    },
}
