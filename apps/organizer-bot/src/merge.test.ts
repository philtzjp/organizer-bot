import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { beforeEach, describe, it } from "node:test"
import type { GitHubRequest, GitHubResponse } from "./github.ts"
import { isMergedWithLabel, type WebhookEvent } from "./index.ts"
import { deleteRefusals, mergePullRequest, reportRefusal, waitForMerge } from "./merge.ts"

const conventions_yml = readFileSync(new URL("../../../packages/conventions/fixtures/conventions.yml", import.meta.url), "utf8")
const repo = "/repos/example-org/app"

type Call = { method: string, path: string, body: unknown }

// 規約に合った PR の本文
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

const default_pull_request = {
    state: "open",
    draft: false,
    title: "docs(docs): 命名規則を追加する",
    body: valid_body,
    user: { login: "alice" },
    head: { ref: "docs/7-naming", sha: "head-sha", repo: { full_name: "example-org/app" } },
    base: { ref: "main", repo: { full_name: "example-org/app", default_branch: "main" } },
}

// GitHub の API の代わりに、決めた応答を返す
const createFakeGitHub = (overrides: Record<string, GitHubResponse> = {}): { request: GitHubRequest, calls: Call[] } => {
    const calls: Call[] = []
    const responses: Record<string, GitHubResponse> = {
        [`GET ${repo}/pulls/7`]: { status: 200, body: default_pull_request },
        [`GET ${repo}/git/ref/heads/main`]: { status: 200, body: { object: { sha: "base-sha" } } },
        [`GET ${repo}/git/ref/heads/docs%2F7-naming`]: { status: 200, body: { object: { sha: "head-sha" } } },
        [`GET ${repo}/compare/base-sha...head-sha`]: { status: 200, body: { behind_by: 0, ahead_by: 2 } },
        [`GET ${repo}/rules/branches/main`]: { status: 200, body: [
            { type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify", integration_id: 15368 }] } },
        ] },
        [`GET ${repo}/branches/main/protection/required_status_checks`]: { status: 404, body: {} },
        [`GET ${repo}/branches/main/protection/required_pull_request_reviews`]: { status: 404, body: {} },
        [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: [
            { name: "verify", status: "completed", conclusion: "success", app: { id: 15368 } },
        ] } },
        [`GET ${repo}/commits/head-sha/status`]: { status: 200, body: { statuses: [] } },
        [`GET ${repo}/pulls/7/files?per_page=100&page=1`]: { status: 200, body: [
            { filename: "docs/naming.md" },
            { filename: "docs/setup.md" },
        ] },
        [`GET ${repo}/contents/.github/conventions.yml`]: { status: 200, body: conventions_yml },
        ["GET /orgs/example-org/memberships/bob"]: { status: 200, body: { role: "member", state: "active" } },
        ["GET /orgs/example-org/memberships/alice"]: { status: 200, body: { role: "admin", state: "active" } },
        [`PUT ${repo}/pulls/7/merge-async`]: { status: 202, body: { status: "pending", details: { uuid: "merge-uuid" } } },
        [`GET ${repo}/pulls/7/merge-async/merge-uuid`]: { status: 200, body: { status: "merged", sha: "merge-sha" } },
        [`POST ${repo}/issues/7/comments`]: { status: 201, body: {} },
        [`GET ${repo}/issues/7/comments?per_page=100&page=1`]: { status: 200, body: [] },
        [`DELETE ${repo}/issues/7/labels/merge`]: { status: 200, body: [] },
        ...overrides,
    }
    const request: GitHubRequest = async (method, path, body) => {
        calls.push({ method, path, body })
        const response = responses[`${method} ${path}`]
        if (response === undefined) {
            throw new Error(`想定していない呼び出し: ${method} ${path}`)
        }
        return response
    }
    return { request, calls }
}

const target = { owner: "example-org", repository: "app", number: 7, labeled_by: "bob" }

const withPullRequest = (changes: Record<string, unknown>): Record<string, GitHubResponse> => ({
    [`GET ${repo}/pulls/7`]: { status: 200, body: { ...default_pull_request, ...changes } },
})

describe("mergePullRequest", () => {
    let fake: ReturnType<typeof createFakeGitHub>

    beforeEach(() => {
        fake = createFakeGitHub()
    })

    it("決めた件名で squash のマージを GitHub に頼む", async () => {
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "pending", uuid: "merge-uuid" })
        const requested = fake.calls.find((call) => call.method === "PUT" && call.path.endsWith("/merge-async"))
        assert.deepEqual(requested?.body, {
            merge_method: "squash",
            merge_action: "direct_merge",
            commit_title: "merge(docs): 命名規則を追加する",
            commit_message: "",
            sha: "head-sha",
            bypass_rules: true,
        })
    })

    it("件名に #N も Co-authored-by も付けず、本文を空にする", async () => {
        await mergePullRequest(fake.request, target)
        const requested = fake.calls.find((call) => call.method === "PUT" && call.path.endsWith("/merge-async"))
        const body = requested?.body as { commit_title: string, commit_message: string }
        assert.ok(!/#\d+/.test(body.commit_title))
        assert.ok(!/co-authored-by/i.test(body.commit_title))
        assert.equal(body.commit_message, "")
    })

    it("ブランチも main も自分では書き換えない", async () => {
        await mergePullRequest(fake.request, target)
        assert.ok(!fake.calls.some((call) => call.method === "PATCH" || (call.method === "POST" && call.path.includes("/git/"))))
    })

    it("GitHub がすぐにマージしたら、マージ済みと返す", async () => {
        fake = createFakeGitHub({ [`PUT ${repo}/pulls/7/merge-async`]: { status: 200, body: { status: "merged", sha: "merge-sha" } } })
        assert.deepEqual(await mergePullRequest(fake.request, target), { status: "merged", sha: "merge-sha" })
    })

    it("GitHub が受け付けなければ、理由を返す", async () => {
        fake = createFakeGitHub({ [`PUT ${repo}/pulls/7/merge-async`]: { status: 400, body: { status: "failed", details: { message: "Pull request is in a draft state" } } } })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
        assert.ok(result.status === "refused" && result.reasons[0]!.includes("draft"))
    })

    it("複数のディレクトリにまたがる PR は repo を scope にする", async () => {
        fake = createFakeGitHub({
            [`GET ${repo}/pulls/7/files?per_page=100&page=1`]: { status: 200, body: [{ filename: "docs/naming.md" }, { filename: "README.md" }] },
        })
        await mergePullRequest(fake.request, target)
        const requested = fake.calls.find((call) => call.method === "PUT" && call.path.endsWith("/merge-async"))
        assert.equal((requested?.body as { commit_title: string }).commit_title, "merge(repo): 命名規則を追加する")
    })

    it("規約のファイルがないリポジトリでは組織の正本を使う", async () => {
        fake = createFakeGitHub({
            [`GET ${repo}/contents/.github/conventions.yml`]: { status: 404, body: {} },
            ["GET /repos/example-org/.github/contents/conventions.yml"]: { status: 200, body: conventions_yml },
        })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "pending")
    })

    it("本文が規約に合っていない PR はマージしない", async () => {
        fake = createFakeGitHub(withPullRequest({ body: "説明だけの本文" }))
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
        assert.ok(!fake.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge-async")))
    })

    it("Draft の PR はマージしない", async () => {
        fake = createFakeGitHub(withPullRequest({ draft: true }))
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
        assert.ok(!fake.calls.some((call) => call.method === "PATCH"))
    })

    it("fork からの PR はマージしない", async () => {
        fake = createFakeGitHub(withPullRequest({ head: { ref: "x", sha: "head-sha", repo: { full_name: "someone/hp" } } }))
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })

    it("タイトルの形が違う PR はマージしない", async () => {
        fake = createFakeGitHub(withPullRequest({ title: "命名規則を追加する" }))
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })

    it("PR の head がブランチの先頭に追いついていなければマージしない", async () => {
        const stale = createFakeGitHub({ [`GET ${repo}/git/ref/heads/docs%2F7-naming`]: { status: 200, body: { object: { sha: "newer-sha" } } } })
        const result = await mergePullRequest(stale.request, target)
        assert.equal(result.status, "refused")
        assert.ok(result.status === "refused" && result.reasons.some((reason) => reason.includes("ブランチの先頭")))
        assert.ok(!stale.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge-async")))
    })

    it("main に追いついていない PR はマージしない", async () => {
        fake = createFakeGitHub({ [`GET ${repo}/compare/base-sha...head-sha`]: { status: 200, body: { behind_by: 1, ahead_by: 2 } } })
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["ブランチが main に追いついていない"] })
    })

    it("必須の検査が終わっていない PR はマージしない", async () => {
        fake = createFakeGitHub({ [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: [
            { name: "verify", status: "in_progress", conclusion: null, app: { id: 15368 } },
        ] } } })
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["必須の検査 verify がまだ終わっていない"] })
    })

    it("必須の検査が失敗している PR はマージしない", async () => {
        fake = createFakeGitHub({ [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: [
            { name: "verify", status: "completed", conclusion: "failure", app: { id: 15368 } },
        ] } } })
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["必須の検査 verify が失敗している"] })
    })

    it("別の App が出した同じ名前の検査は数えない", async () => {
        fake = createFakeGitHub({ [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: [
            { name: "verify", status: "completed", conclusion: "success", app: { id: 999 } },
        ] } } })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })

})

describe("必須の検査が決まっていないリポジトリ", () => {
    const without_required = (runs: { name: string, status: string, conclusion: string | null }[], workflows: { name: string, status: string, conclusion: string | null }[], statuses: { context: string, state: string }[] = []): Record<string, GitHubResponse> => ({
        [`GET ${repo}/rules/branches/main`]: { status: 200, body: [] },
        [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: runs.map((run) => ({ ...run, app: { id: 15368 } })) } },
        [`GET ${repo}/commits/head-sha/status`]: { status: 200, body: { statuses } },
        [`GET ${repo}/actions/runs?head_sha=head-sha&per_page=100`]: { status: 200, body: { workflow_runs: workflows } },
    })

    it("CI がまだ終わっていなければマージしない", async () => {
        const fake = createFakeGitHub(without_required([{ name: "verify", status: "in_progress", conclusion: null }], [{ name: "ci", status: "in_progress", conclusion: null }]))
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["検査 verify がまだ終わっていない", "workflow ci がまだ終わっていない"] })
        assert.ok(!fake.calls.some((call) => call.method === "PUT" && call.path.endsWith("/merge-async")))
    })

    it("CI が失敗していればマージしない", async () => {
        const fake = createFakeGitHub(without_required([{ name: "verify", status: "completed", conclusion: "failure" }], [], [{ context: "example-bot/conventions", state: "success" }]))
        assert.deepEqual(await mergePullRequest(fake.request, target), { status: "refused", reasons: ["検査 verify が失敗している"] })
    })

    it("全部が通っていればマージを頼む", async () => {
        const fake = createFakeGitHub(without_required([{ name: "verify", status: "completed", conclusion: "success" }], [{ name: "ci", status: "completed", conclusion: "success" }], [{ context: "example-bot/conventions", state: "success" }]))
        assert.deepEqual(await mergePullRequest(fake.request, target), { status: "pending", uuid: "merge-uuid" })
    })
})

describe("waitForMerge", () => {
    const pull_request = { owner: "example-org", repository: "app", number: 7 }
    const no_wait = async (): Promise<void> => {}

    it("マージされたら、マージのコミットを返す", async () => {
        const fake = createFakeGitHub()
        assert.deepEqual(await waitForMerge(fake.request, pull_request, "merge-uuid", 3, no_wait), { status: "merged", sha: "merge-sha" })
    })

    it("失敗したら、理由を返す", async () => {
        const fake = createFakeGitHub({ [`GET ${repo}/pulls/7/merge-async/merge-uuid`]: { status: 200, body: { status: "failed", details: { message: "Head branch was modified" } } } })
        assert.deepEqual(await waitForMerge(fake.request, pull_request, "merge-uuid", 3, no_wait), { status: "failed", message: "Head branch was modified" })
    })

    it("決めた回数で終わらなければ、まだ終わっていないと返す", async () => {
        const fake = createFakeGitHub({ [`GET ${repo}/pulls/7/merge-async/merge-uuid`]: { status: 200, body: { status: "pending", details: { uuid: "merge-uuid" } } } })
        assert.deepEqual(await waitForMerge(fake.request, pull_request, "merge-uuid", 3, no_wait), { status: "pending" })
        assert.equal(fake.calls.filter((call) => call.path.endsWith("/merge-async/merge-uuid")).length, 3)
    })
})

describe("isMergedWithLabel", () => {
    const event = (changes: Record<string, unknown>, labels = [{ name: "merge" }]): WebhookEvent => ({
        action: "closed",
        installation: { id: 1 },
        sender: { login: "example-bot[bot]" },
        repository: { name: "app", owner: { login: "example-org" } },
        pull_request: { number: 7, state: "closed", title: "t", body: null, user: { login: "alice" }, head: { sha: "head-sha" }, base: { ref: "main" }, labels, merged: true, ...changes },
    })

    it("merge ラベルの付いた PR がマージされたイベントを扱う", () => {
        assert.equal(isMergedWithLabel("pull_request", event({})), true)
    })

    it("マージされずに閉じた PR は扱わない", () => {
        assert.equal(isMergedWithLabel("pull_request", event({ merged: false })), false)
    })

    it("merge ラベルのない PR は扱わない", () => {
        assert.equal(isMergedWithLabel("pull_request", event({}, [])), false)
    })
})

describe("reportRefusal", () => {
    it("理由をコメントし、ラベルを外す", async () => {
        const fake = createFakeGitHub()
        await reportRefusal(fake.request, target, ["PR が Draft のまま"])
        const comment = fake.calls.find((call) => call.method === "POST" && call.path.endsWith("/comments"))
        const body = (comment?.body as { body: string }).body
        assert.ok(body.startsWith("✳︎ example-bot\n\n"))
        assert.ok(body.includes("- PR が Draft のまま"))
        assert.ok(fake.calls.some((call) => call.method === "DELETE" && call.path.endsWith("/labels/merge")))
    })

    // 前に断ったコメント 2 つ（目印のあるものと、目印を付ける前のもの）と、人が書いた同じ文面のコメント
    const comments = {
        [`GET ${repo}/issues/7/comments?per_page=100&page=1`]: { status: 200, body: [
            { id: 1, body: "✳︎ example-bot\n\n<!-- example-bot:merge-refusal -->\n次の理由でマージしませんでした。", user: { login: "example-bot[bot]" } },
            { id: 2, body: "✳︎ example-bot\n\n次の理由でマージしませんでした。直してから", user: { login: "example-bot[bot]" } },
            { id: 3, body: "次の理由でマージしませんでした。と bot に言われた", user: { login: "alice" } },
        ] },
        [`DELETE ${repo}/issues/comments/1`]: { status: 204, body: null },
        [`DELETE ${repo}/issues/comments/2`]: { status: 404, body: {} },
    }

    it("前に断ったコメントを消してから、新しいコメントを 1 つ置く", async () => {
        const fake = createFakeGitHub(comments)
        await reportRefusal(fake.request, target, ["PR が Draft のまま"])
        const deleted = fake.calls.filter((call) => call.method === "DELETE" && call.path.includes("/issues/comments/")).map((call) => call.path)
        assert.deepEqual(deleted, [`${repo}/issues/comments/1`, `${repo}/issues/comments/2`])
        const deleted_at = fake.calls.findIndex((call) => call.method === "DELETE" && call.path.includes("/issues/comments/"))
        const posted_at = fake.calls.findIndex((call) => call.method === "POST" && call.path.endsWith("/comments"))
        assert.ok(deleted_at < posted_at)
        const body = (fake.calls[posted_at]?.body as { body: string }).body
        assert.ok(body.includes("<!-- example-bot:merge-refusal -->"))
    })
})

describe("deleteRefusals", () => {
    it("ボットが書いた断ったコメントだけを消し、人のコメントには触らない", async () => {
        const fake = createFakeGitHub({
            [`GET ${repo}/issues/7/comments?per_page=100&page=1`]: { status: 200, body: [
                { id: 1, body: "<!-- example-bot:merge-refusal -->", user: { login: "example-bot[bot]" } },
                { id: 4, body: "✳︎ example-bot\n\nフッターを取り除きました", user: { login: "example-bot[bot]" } },
                { id: 3, body: "次の理由でマージしませんでした。", user: { login: "alice" } },
            ] },
            [`DELETE ${repo}/issues/comments/1`]: { status: 204, body: null },
        })
        await deleteRefusals(fake.request, target)
        const deleted = fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path)
        assert.deepEqual(deleted, [`${repo}/issues/comments/1`])
    })
})

describe("承認の条件", () => {
    const rules_with_approval = (dismiss_stale: boolean): Record<string, GitHubResponse> => ({
        [`GET ${repo}/rules/branches/main`]: { status: 200, body: [
            { type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify", integration_id: 15368 }] } },
            { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: dismiss_stale } },
        ] },
    })
    const reviews = (items: unknown[]): Record<string, GitHubResponse> => ({
        [`GET ${repo}/pulls/7/reviews?per_page=100&page=1`]: { status: 200, body: items },
    })

    it("必要な数の承認があればマージする", async () => {
        const fake = createFakeGitHub({ ...rules_with_approval(false), ...reviews([
            { user: { login: "bob" }, state: "APPROVED", commit_id: "old-sha" },
        ]) })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "pending")
    })

    it("承認がなければマージしない", async () => {
        const fake = createFakeGitHub({ ...rules_with_approval(false), ...reviews([
            { user: { login: "bob" }, state: "COMMENTED", commit_id: "head-sha" },
        ]) })
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["承認が 1 件要るが、0 件しかない"] })
    })

    it("PR を出した人の承認は数えない", async () => {
        const fake = createFakeGitHub({ ...rules_with_approval(false), ...reviews([
            { user: { login: "alice" }, state: "APPROVED", commit_id: "head-sha" },
        ]) })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })

    it("承認のあとに変更要求を出した人の承認は数えない", async () => {
        const fake = createFakeGitHub({ ...rules_with_approval(false), ...reviews([
            { user: { login: "bob" }, state: "APPROVED", commit_id: "head-sha" },
            { user: { login: "bob" }, state: "CHANGES_REQUESTED", commit_id: "head-sha" },
        ]) })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })

    it("新しい push で古い承認を無効にするルールでは、古いコミットへの承認を数えない", async () => {
        const fake = createFakeGitHub({ ...rules_with_approval(true), ...reviews([
            { user: { login: "bob" }, state: "APPROVED", commit_id: "old-sha" },
        ]) })
        const result = await mergePullRequest(fake.request, target)
        assert.equal(result.status, "refused")
    })
})

describe("owner がラベルを付けた PR", () => {
    const approval_rules: Record<string, GitHubResponse> = {
        [`GET ${repo}/rules/branches/main`]: { status: 200, body: [
            { type: "required_status_checks", parameters: { required_status_checks: [{ context: "verify", integration_id: 15368 }] } },
            { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: false } },
        ] },
    }

    it("承認がなくてもマージする", async () => {
        const fake = createFakeGitHub(approval_rules)
        const result = await mergePullRequest(fake.request, { ...target, labeled_by: "alice" })
        assert.equal(result.status, "pending")
        assert.ok(!fake.calls.some((call) => call.path.includes("/reviews")))
    })

    it("owner でない人がラベルを付けたら承認を確かめる", async () => {
        const fake = createFakeGitHub({ ...approval_rules, [`GET ${repo}/pulls/7/reviews?per_page=100&page=1`]: { status: 200, body: [] } })
        const result = await mergePullRequest(fake.request, target)
        assert.deepEqual(result, { status: "refused", reasons: ["承認が 1 件要るが、0 件しかない"] })
    })

    it("owner がラベルを付けても、必須の検査が失敗していればマージしない", async () => {
        const fake = createFakeGitHub({ ...approval_rules, [`GET ${repo}/commits/head-sha/check-runs?per_page=100&page=1`]: { status: 200, body: { check_runs: [
            { name: "verify", status: "completed", conclusion: "failure", app: { id: 15368 } },
        ] } } })
        const result = await mergePullRequest(fake.request, { ...target, labeled_by: "alice" })
        assert.equal(result.status, "refused")
    })
})

