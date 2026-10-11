import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { GitHubRequest, GitHubResponse } from "./github.ts"
import { collectStats, firstWeek } from "./stats-collect.ts"
import { blobSha, publishFiles, stats_message } from "./stats-publish.ts"
import { renderStats, type Stats } from "./stats-render.ts"

type Call = { method: string, path: string, body: unknown }

const now = new Date("2026-10-07T12:00:00Z")

const repository = (name: string, options: { private?: boolean, archived?: boolean, fork?: boolean, commits?: number, languages?: [string, number][] } = {}) => ({
    id: `id-${name}`,
    name,
    isPrivate: options.private ?? true,
    isArchived: options.archived ?? false,
    isFork: options.fork ?? false,
    languages: { edges: (options.languages ?? []).map(([language, size]) => ({ size, node: { name: language, color: "#123456" } })) },
    defaultBranchRef: { target: { history: { totalCount: options.commits ?? 0 } } },
})

const createFakeGraphQL = (repositories: ReturnType<typeof repository>[], dates: Record<string, string[]>): { request: GitHubRequest, calls: Call[] } => {
    const calls: Call[] = []
    const request: GitHubRequest = async (method, path, body) => {
        calls.push({ method, path, body })
        const variables = (body as { variables: Record<string, unknown> }).variables
        if (variables.organization !== undefined) {
            return { status: 200, body: { data: { organization: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: repositories } } } } } satisfies GitHubResponse
        }
        const nodes = (dates[variables.id as string] ?? []).map((committedDate) => ({ committedDate }))
        return { status: 200, body: { data: { node: { defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } } } }
    }
    return { request, calls }
}

describe("collectStats", () => {
    it("週を日曜で区切り、今週を含めて 52 週を見る", () => {
        assert.equal(firstWeek(now).toISOString(), "2025-10-12T00:00:00.000Z")
    })

    it("外すリポジトリと fork と archive 済みを、それぞれの決まりで数える", async () => {
        const fake = createFakeGraphQL([
            repository("app", { private: false, commits: 2, languages: [["TypeScript", 300]] }),
            repository("skrivt", { commits: 1, languages: [["Swift", 100], ["TypeScript", 100]] }),
            repository("excluded-repository", { commits: 5, languages: [["HTML", 9999]] }),
            repository("forked", { fork: true, commits: 9, languages: [["C", 500]] }),
            repository("old", { archived: true, commits: 1, languages: [["Perl", 50]] }),
        ], {
            "id-app": ["2026-10-06T00:00:00Z", "2025-10-12T01:00:00Z"],
            "id-skrivt": ["2026-10-04T00:00:00Z"],
            "id-old": ["2026-01-01T00:00:00Z"],
        })
        const stats = await collectStats(fake.request, "example-org", now)
        // excluded-repository は外し、fork は履歴を読まない
        assert.deepEqual(stats.repositories, { public: 1, private: 2, archived: 1 })
        assert.ok(!fake.calls.some((call) => (call.body as { variables: { id?: string } }).variables.id === "id-excluded-repository"))
        assert.ok(!fake.calls.some((call) => (call.body as { variables: { id?: string } }).variables.id === "id-forked"))
        // archive 済みもコミットは数え、言語は数えない
        assert.equal(stats.weekly_commits.reduce((sum, week) => sum + week.count, 0), 4)
        // 最初の週の日曜 1 時と、今週の日曜と月曜を数える
        assert.equal(stats.weekly_commits[0]!.count, 1)
        assert.equal(stats.weekly_commits[51]!.count, 2)
        assert.deepEqual(stats.languages.map((language) => [language.name, language.bytes]), [["TypeScript", 400], ["Swift", 100]])
    })
})

const sample: Stats = {
    generated_at: now.toISOString(),
    repositories: { public: 4, private: 37, archived: 78 },
    weekly_commits: Array.from({ length: 52 }, (_, index) => ({ week_start: new Date(firstWeek(now).getTime() + index * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), count: index })),
    languages: [{ name: "Rust", color: "#dea584", bytes: 70 }, { name: "C++", color: "#f34b7d", bytes: 30 }],
}

describe("renderStats", () => {
    it("広い画面用とスマートフォン用を、明るい表示用と暗い表示用で作る", () => {
        const files = renderStats(sample)
        assert.deepEqual(Object.keys(files).sort(), ["stats-narrow-dark.svg", "stats-narrow-light.svg", "stats-wide-dark.svg", "stats-wide-light.svg"])
        for (const svg of Object.values(files)) {
            assert.ok(svg.startsWith("<svg "))
            assert.ok(svg.includes(">41<"))
            assert.ok(svg.includes("C++"))
        }
    })

    it("同じ統計からは同じ SVG を作る", () => {
        assert.deepEqual(renderStats(sample), renderStats(sample))
    })
})

describe("publishFiles", () => {
    const target = { owner: "example-org", repository: ".github", branch: "main", directory: "images", message: stats_message }

    const createFakeGitHub = async (existing: Record<string, string>): Promise<{ request: GitHubRequest, calls: Call[] }> => {
        const calls: Call[] = []
        const tree = await Promise.all(Object.entries(existing).map(async ([path, content]) => ({ path, sha: await blobSha(content) })))
        const request: GitHubRequest = async (method, path, body) => {
            calls.push({ method, path, body })
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

    it("git と同じ方法で blob の sha を出す", async () => {
        assert.equal(await blobSha("hello svg\n"), "65c18643f34c1f1d728f3155a4873c1a8157b33a")
    })

    it("中身が同じならコミットしない", async () => {
        const fake = await createFakeGitHub({ "images/a.svg": "<svg/>" })
        assert.deepEqual(await publishFiles(fake.request, target, { "a.svg": "<svg/>" }), { status: "unchanged" })
        assert.ok(!fake.calls.some((call) => call.method === "POST" || call.method === "PATCH"))
    })

    it("変わったファイルだけを書き、早送りでブランチを進める", async () => {
        const fake = await createFakeGitHub({ "images/a.svg": "<svg/>", "images/b.svg": "<svg/>" })
        const result = await publishFiles(fake.request, target, { "a.svg": "<svg/>", "b.svg": "<svg>new</svg>" })
        assert.deepEqual(result, { status: "committed", sha: "new-commit", changed: ["images/b.svg"] })
        const tree = fake.calls.find((call) => call.method === "POST" && call.path.endsWith("/git/trees"))
        assert.deepEqual((tree?.body as { tree: { path: string }[] }).tree.map((entry) => entry.path), ["images/b.svg"])
        const commit = fake.calls.find((call) => call.method === "POST" && call.path.endsWith("/git/commits"))
        assert.equal((commit?.body as { message: string }).message, stats_message)
        assert.deepEqual(fake.calls.at(-1), { method: "PATCH", path: "/repos/example-org/.github/git/refs/heads/main", body: { sha: "new-commit", force: false } })
    })
})
