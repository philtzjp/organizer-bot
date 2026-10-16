import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"
import type { GitHubRequest } from "./github.ts"
import { scheduledTasks, skill_cron, stats_cron } from "./index.ts"
import { conventions_skill_message, isConventionsSource, syncConventionsSkill } from "./skill-sync.ts"
import { blobSha } from "./stats-publish.ts"

type Call = { method: string, path: string, body: unknown, accept: string | undefined }

// 写す元のパスと中身。検査器は example-org/organizer-bot に、規約は example-org/.github にある
const sources: Record<string, string> = {
    "/repos/example-org/organizer-bot/contents/packages/conventions/skill/SKILL.md": "# conventions\n",
    "/repos/example-org/organizer-bot/contents/packages/conventions/skill/cli.mjs": "console.log(1)\n",
    "/repos/example-org/.github/contents/conventions.yml": "commit: {}\n",
}

// skills の main に existing のファイルがある GitHub を作る
const createFakeGitHub = async (existing: Record<string, string>): Promise<{ request: GitHubRequest, calls: Call[] }> => {
    const calls: Call[] = []
    const tree = await Promise.all(Object.entries(existing).map(async ([path, content]) => ({ path, sha: await blobSha(content) })))
    const request: GitHubRequest = async (method, path, body, accept) => {
        calls.push({ method, path, body, accept })
        const source = Object.keys(sources).find((key) => path === `${key}?ref=main`)
        if (source !== undefined) {
            return { status: 200, body: sources[source] }
        }
        if (path.endsWith("/git/ref/heads/main")) {
            return { status: 200, body: { object: { sha: "head-sha" } } }
        }
        if (path.endsWith("/git/commits/head-sha")) {
            return { status: 200, body: { tree: { sha: "tree-sha" } } }
        }
        if (path.includes("/git/trees/tree-sha")) {
            return { status: 200, body: { tree } }
        }
        if (method === "POST" && path.endsWith("/git/trees")) {
            return { status: 201, body: { sha: "new-tree" } }
        }
        if (method === "POST" && path.endsWith("/git/commits")) {
            return { status: 201, body: { sha: "new-commit" } }
        }
        return { status: 200, body: {} }
    }
    return { request, calls }
}

describe("syncConventionsSkill", () => {
    it("検査器と規約の main の 3 つのファイルを、skills の conventions スキルに写す", async () => {
        const fake = await createFakeGitHub({})
        const result = await syncConventionsSkill(fake.request)
        assert.deepEqual(result, {
            status: "committed",
            sha: "new-commit",
            changed: [".agents/skills/conventions/SKILL.md", ".agents/skills/conventions/cli.mjs", ".agents/skills/conventions/conventions.yml"],
        })
        const reads = fake.calls.filter((call) => call.path.includes("/contents/"))
        assert.ok(reads.every((call) => call.accept === "application/vnd.github.raw+json"))
        const commit = fake.calls.find((call) => call.method === "POST" && call.path === "/repos/example-org/skills/git/commits")
        assert.equal((commit?.body as { message: string }).message, conventions_skill_message)
        assert.deepEqual(fake.calls.at(-1), { method: "PATCH", path: "/repos/example-org/skills/git/refs/heads/main", body: { sha: "new-commit", force: false }, accept: undefined })
    })

    it("skills の中身が写す元と同じなら、コミットしない", async () => {
        const fake = await createFakeGitHub({
            ".agents/skills/conventions/SKILL.md": sources["/repos/example-org/organizer-bot/contents/packages/conventions/skill/SKILL.md"]!,
            ".agents/skills/conventions/cli.mjs": sources["/repos/example-org/organizer-bot/contents/packages/conventions/skill/cli.mjs"]!,
            ".agents/skills/conventions/conventions.yml": sources["/repos/example-org/.github/contents/conventions.yml"]!,
        })
        assert.deepEqual(await syncConventionsSkill(fake.request), { status: "unchanged" })
        assert.ok(!fake.calls.some((call) => call.method === "POST" || call.method === "PATCH"))
    })

    it("写す元のファイルが読めなければ、何も書かずに止める", async () => {
        const fake = await createFakeGitHub({})
        const request: GitHubRequest = async (method, path, body, accept) =>
            path.includes("/.github/contents/conventions.yml") ? { status: 404, body: { message: "Not Found" } } : fake.request(method, path, body, accept)
        await assert.rejects(syncConventionsSkill(request), /conventions\.yml を読む: 404/)
        assert.ok(!fake.calls.some((call) => call.method === "POST" || call.method === "PATCH"))
    })
})

describe("isConventionsSource", () => {
    it("検査器と規約のリポジトリだけを写す元にする", () => {
        assert.equal(isConventionsSource("example-org", "organizer-bot"), true)
        assert.equal(isConventionsSource("example-org", ".github"), true)
        assert.equal(isConventionsSource("example-org", "skills"), false)
    })
})

describe("scheduledTasks", () => {
    it("毎日の cron では conventions スキルの写しだけを動かす", () => {
        assert.deepEqual(scheduledTasks(skill_cron), ["skill"])
    })

    it("週に 1 回の cron では統計を動かす", () => {
        assert.deepEqual(scheduledTasks(stats_cron), ["stats"])
    })

    it("スキルのリポジトリがなければ、毎日の cron で何もしない", () => {
        assert.deepEqual(scheduledTasks(skill_cron, { skills_repository: undefined, profile_repository: "example-org/.github" }), [])
    })

    it("プロフィールのリポジトリがなければ、週に 1 回の cron で何もしない", () => {
        assert.deepEqual(scheduledTasks(stats_cron, { skills_repository: "example-org/skills", profile_repository: undefined }), [])
    })

    it("知らない cron では何もしない", () => {
        assert.deepEqual(scheduledTasks("0 0 * * *"), [])
    })

    it("wrangler.jsonc の cron と同じ式を使う", () => {
        const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")
        const crons = JSON.parse(/"crons":\s*(\[[^\]]*\])/.exec(wrangler)?.[1] ?? "[]") as string[]
        assert.deepEqual([...crons].sort(), [stats_cron, skill_cron].sort())
    })
})
