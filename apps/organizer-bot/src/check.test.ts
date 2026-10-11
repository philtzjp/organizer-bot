import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import { checkConventions, status_context, type CheckTarget } from "./check.ts"
import type { GitHubRequest, GitHubResponse } from "./github.ts"
import { readCheckTarget, type WebhookEvent } from "./index.ts"

const conventions_yml = readFileSync(new URL("../../../packages/conventions/fixtures/conventions.yml", import.meta.url), "utf8")
const repo = "/repos/example-org/app"
const marker = "<!-- example-bot:conventions -->"

type Call = { method: string, path: string, body: unknown }

const valid_body = [
    "✳︎ Anthropic Claude Opus 5.5",
    "",
    "## 背景",
    "",
    "- 名前の付け方が場所ごとに違う",
    "",
    "## 作業範囲",
    "",
    "- 命名規則を書いた",
    "",
    "## 受け入れ条件",
    "",
    "- [x] 命名規則が書かれている",
    "",
    "## 影響範囲・残リスク",
    "",
    "- 影響範囲: 文書だけ",
].join("\n")

const createFakeGitHub = (comments: unknown[] = []): { request: GitHubRequest, calls: Call[] } => {
    const calls: Call[] = []
    const request: GitHubRequest = async (method, path, body) => {
        calls.push({ method, path, body })
        if (method === "GET" && path === `${repo}/contents/.github/conventions.yml`) {
            return { status: 200, body: conventions_yml } satisfies GitHubResponse
        }
        if (method === "GET" && path.startsWith(`${repo}/issues/7/comments`)) {
            return { status: 200, body: comments }
        }
        return { status: method === "DELETE" ? 204 : method === "POST" ? 201 : 200, body: {} }
    }
    return { request, calls }
}

const pull_request: CheckTarget = {
    owner: "example-org",
    repository: "app",
    kind: "pull_request",
    number: 7,
    title: "docs(docs): 命名規則を追加する",
    body: valid_body,
    head_sha: "head-sha",
}

const statusOf = (calls: Call[]): unknown => calls.find((call) => call.path === `${repo}/statuses/head-sha`)?.body

describe("checkConventions", () => {
    it("規約に合った PR には成功のステータスを付け、コメントしない", async () => {
        const fake = createFakeGitHub()
        const violations = await checkConventions(fake.request, pull_request)
        assert.deepEqual(violations, [])
        assert.equal((statusOf(fake.calls) as { state: string, context: string }).state, "success")
        assert.equal((statusOf(fake.calls) as { context: string }).context, status_context)
        assert.ok(!fake.calls.some((call) => call.path.endsWith("/comments") && call.method === "POST"))
    })

    it("違反のある PR には失敗のステータスを付け、違反をコメントする", async () => {
        const fake = createFakeGitHub()
        const violations = await checkConventions(fake.request, { ...pull_request, title: "命名規則" })
        assert.ok(violations.length > 0)
        assert.equal((statusOf(fake.calls) as { state: string }).state, "failure")
        const comment = fake.calls.find((call) => call.method === "POST" && call.path === `${repo}/issues/7/comments`)
        const body = (comment?.body as { body: string }).body
        assert.ok(body.startsWith("✳︎ example-bot\n\n"))
        assert.ok(body.includes(marker))
    })

    it("フッターは取り除いたものとして検査する", async () => {
        const fake = createFakeGitHub()
        const violations = await checkConventions(fake.request, { ...pull_request, body: `${valid_body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)` })
        assert.deepEqual(violations, [])
    })

    it("前の違反のコメントがあれば、新しく作らずに書き直す", async () => {
        const fake = createFakeGitHub([{ id: 11, body: `${marker}\n古い内容`, user: { login: "example-bot[bot]" } }])
        await checkConventions(fake.request, { ...pull_request, title: "命名規則" })
        assert.ok(fake.calls.some((call) => call.method === "PATCH" && call.path === `${repo}/issues/comments/11`))
        assert.ok(!fake.calls.some((call) => call.method === "POST" && call.path.endsWith("/comments")))
    })

    it("署名の付いた違反のコメントも書き直す", async () => {
        const fake = createFakeGitHub([{ id: 13, body: `✳︎ example-bot\n\n${marker}\n古い内容`, user: { login: "example-bot[bot]" } }])
        await checkConventions(fake.request, { ...pull_request, title: "命名規則" })
        assert.ok(fake.calls.some((call) => call.method === "PATCH" && call.path === `${repo}/issues/comments/13`))
    })

    it("直ったら違反のコメントを消す", async () => {
        const fake = createFakeGitHub([{ id: 11, body: `${marker}\n古い内容`, user: { login: "example-bot[bot]" } }])
        await checkConventions(fake.request, pull_request)
        assert.ok(fake.calls.some((call) => call.method === "DELETE" && call.path === `${repo}/issues/comments/11`))
    })

    it("人が書いた同じ目印のコメントには触らない", async () => {
        const fake = createFakeGitHub([{ id: 12, body: `${marker}\n人のコメント`, user: { login: "alice" } }])
        await checkConventions(fake.request, pull_request)
        assert.ok(!fake.calls.some((call) => call.method === "DELETE"))
    })

    it("Issue にはステータスを付けない", async () => {
        const fake = createFakeGitHub()
        const { head_sha: _, ...issue } = pull_request
        await checkConventions(fake.request, { ...issue, kind: "issue", title: "命名規則" })
        assert.ok(!fake.calls.some((call) => call.path.includes("/statuses/")))
        assert.ok(fake.calls.some((call) => call.method === "POST" && call.path === `${repo}/issues/7/comments`))
    })
})

describe("readCheckTarget", () => {
    const common = { installation: { id: 1 }, sender: { login: "alice" }, repository: { name: "app", owner: { login: "example-org" } } }
    const pull = { number: 7, state: "open", title: "docs(docs): x を書く", body: "b", user: { login: "alice" }, head: { sha: "head-sha" }, base: { ref: "main" }, labels: [] }

    it("PR の push では先頭のコミットを対象にする", () => {
        const event: WebhookEvent = { ...common, action: "synchronize", pull_request: pull }
        assert.equal(readCheckTarget("pull_request", event)?.head_sha, "head-sha")
    })

    it("閉じた PR は検査しない", () => {
        const event: WebhookEvent = { ...common, action: "edited", pull_request: { ...pull, state: "closed" } }
        assert.equal(readCheckTarget("pull_request", event), undefined)
    })

    it("ラベルのイベントは検査しない", () => {
        const event: WebhookEvent = { ...common, action: "labeled", pull_request: pull }
        assert.equal(readCheckTarget("pull_request", event), undefined)
    })

    it("Issue の作成と編集を検査する", () => {
        const event: WebhookEvent = { ...common, action: "opened", issue: { number: 3, state: "open", title: "t", body: null, user: { login: "alice" } } }
        assert.equal(readCheckTarget("issues", event)?.kind, "issue")
    })
})
