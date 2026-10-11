// org のプロフィールに出す統計を、org の全リポジトリから集める。何も書き換えない。
// 集計から外すリポジトリは config.stats_excluded_repositories に挙げる。
// private のリポジトリも読むが、返すのは数と合計だけにし、リポジトリの名前と中身は出さない
import { config } from "./config.ts"
import { expectOk, type GitHubRequest } from "./github.ts"
import type { Stats } from "./stats-render.ts"


const week_milliseconds = 7 * 24 * 60 * 60 * 1000

type Repository = {
    id: string
    name: string
    isPrivate: boolean
    isArchived: boolean
    isFork: boolean
    languages: { edges: { size: number, node: { name: string, color: string | null } }[] }
    defaultBranchRef: { target: { history: { totalCount: number } } | null } | null
}

const graphql = async <T>(request: GitHubRequest, query: string, variables: Record<string, unknown>): Promise<T> => {
    const body = expectOk(await request("POST", "/graphql", { query, variables }), "GraphQL で統計を読む") as { data?: T, errors?: unknown[] }
    if (body.errors !== undefined || body.data === undefined) {
        // 本文にリポジトリの名前が入ることがあるので、件数だけを出す
        throw new Error(`GraphQL で統計を読めなかった: errors=${body.errors?.length ?? 0}`)
    }
    return body.data
}

// 週は日曜で区切る。今週を含めて 52 週を見る
export const firstWeek = (now: Date): Date => {
    const this_week = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay())
    return new Date(this_week - 51 * week_milliseconds)
}

export const collectStats = async (request: GitHubRequest, organization: string, now = new Date()): Promise<Stats> => {
    const first_week = firstWeek(now)
    const since = first_week.toISOString()

    const repositories: Repository[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page += 1) {
        const data: { organization: { repositories: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Repository[] } } } = await graphql(request, `
            query($organization: String!, $cursor: String, $since: GitTimestamp!) {
                organization(login: $organization) {
                    repositories(first: 50, after: $cursor) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            id
                            name
                            isPrivate
                            isArchived
                            isFork
                            languages(first: 30, orderBy: { field: SIZE, direction: DESC }) {
                                edges { size node { name color } }
                            }
                            defaultBranchRef {
                                target { ... on Commit { history(since: $since) { totalCount } } }
                            }
                        }
                    }
                }
            }
        `, { organization, cursor, since })
        repositories.push(...data.organization.repositories.nodes.filter((repository) => !config.stats_excluded_repositories.has(repository.name)))
        if (!data.organization.repositories.pageInfo.hasNextPage) {
            break
        }
        cursor = data.organization.repositories.pageInfo.endCursor
    }

    // コミットは default ブランチの履歴を数える。fork は元のリポジトリの履歴を含むので数えない
    const weekly = new Array<number>(52).fill(0)
    for (const repository of repositories.filter((candidate) => !candidate.isFork && (candidate.defaultBranchRef?.target?.history.totalCount ?? 0) > 0)) {
        let history_cursor: string | null = null
        for (let page = 0; page < 100; page += 1) {
            const data: { node: { defaultBranchRef: { target: { history: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: { committedDate: string }[] } } } } } = await graphql(request, `
                query($id: ID!, $cursor: String, $since: GitTimestamp!) {
                    node(id: $id) {
                        ... on Repository {
                            defaultBranchRef {
                                target { ... on Commit { history(first: 100, after: $cursor, since: $since) {
                                    pageInfo { hasNextPage endCursor }
                                    nodes { committedDate }
                                } } }
                            }
                        }
                    }
                }
            `, { id: repository.id, cursor: history_cursor, since })
            const history = data.node.defaultBranchRef.target.history
            for (const commit of history.nodes) {
                const index = Math.floor((new Date(commit.committedDate).getTime() - first_week.getTime()) / week_milliseconds)
                if (index >= 0 && index < 52) {
                    weekly[index]! += 1
                }
            }
            if (!history.pageInfo.hasNextPage) {
                break
            }
            history_cursor = history.pageInfo.endCursor
        }
    }

    // 言語は、archive していない fork でないリポジトリの合計にする
    const languages = new Map<string, { color: string | null, bytes: number }>()
    for (const repository of repositories.filter((candidate) => !candidate.isFork && !candidate.isArchived)) {
        for (const edge of repository.languages.edges) {
            const current = languages.get(edge.node.name) ?? { color: edge.node.color, bytes: 0 }
            current.bytes += edge.size
            languages.set(edge.node.name, current)
        }
    }

    const active = repositories.filter((candidate) => !candidate.isArchived)
    return {
        generated_at: now.toISOString(),
        repositories: {
            public: active.filter((candidate) => !candidate.isPrivate).length,
            private: active.filter((candidate) => candidate.isPrivate).length,
            archived: repositories.length - active.length,
        },
        weekly_commits: weekly.map((count, index) => ({
            week_start: new Date(first_week.getTime() + index * week_milliseconds).toISOString().slice(0, 10),
            count,
        })),
        languages: [...languages.entries()]
            .map(([name, value]) => ({ name, color: value.color, bytes: value.bytes }))
            .sort((left, right) => right.bytes - left.bytes),
    }
}
