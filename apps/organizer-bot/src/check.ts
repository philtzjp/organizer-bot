import { checkIssue, checkPullRequest, stripFooters, type Conventions } from "@philtz/conventions/rules"
import { readConventions } from "./conventions.ts"
import { botCommitter, botSignature, expectOk, readAll, type GitHubRequest } from "./github.ts"
import { config } from "./config.ts"

// PR の先頭のコミットに付けるステータスの名前
export const status_context = "organizer-bot/conventions"

// 違反をまとめたコメントの目印。このコメントだけを書き直し、直ったら消す
// 違反のコメントの目印。本番では <!-- <bot の login>:conventions --> になる
const reportMarker = (): string => `<!-- ${config.bot_login}:conventions -->`

export type CheckTarget = {
    owner: string
    repository: string
    kind: "issue" | "pull_request"
    number: number
    title: string
    body: string
    // PR の先頭のコミット。Issue にはない
    head_sha?: string
}

// フッターはボットが取り除くので、取り除いたあとの本文で検査する
export const findViolations = (conventions: Conventions, kind: CheckTarget["kind"], title: string, body: string): string[] => {
    const cleaned = stripFooters(conventions, body).body
    return kind === "pull_request" ? checkPullRequest(conventions, title, cleaned) : checkIssue(conventions, title, cleaned)
}

const reportBody = (kind: CheckTarget["kind"], violations: string[]): string => [
    botSignature(),
    "",
    reportMarker(),
    `${kind === "pull_request" ? "PR" : "Issue"} のタイトルと本文が、規約の \`.github/conventions.yml\` に合っていません。直すと、このコメントは消えます。`,
    "",
    ...violations.map((violation) => `- ${violation}`),
].join("\n")

type Comment = { id: number, body: string | null, user: { login: string } | null }

// 違反があればコメントを 1 つだけ置き、なければ消す
const updateReport = async (request: GitHubRequest, target: CheckTarget, violations: string[]): Promise<void> => {
    const full_name = `${target.owner}/${target.repository}`
    const comments = await readAll<Comment>(request, `/repos/${full_name}/issues/${target.number}/comments`, (body) => body as Comment[])
    const existing = comments.find((comment) => comment.user?.login === botCommitter().name && (comment.body ?? "").includes(reportMarker()))
    if (violations.length === 0) {
        if (existing !== undefined) {
            const response = await request("DELETE", `/repos/${full_name}/issues/comments/${existing.id}`)
            // すでに消えているときは 404 になる
            if (response.status !== 404) {
                expectOk(response, "違反のコメントを消す")
            }
        }
        return
    }
    const body = reportBody(target.kind, violations)
    if (existing === undefined) {
        expectOk(await request("POST", `/repos/${full_name}/issues/${target.number}/comments`, { body }), "違反をコメントする")
    } else if (existing.body !== body) {
        expectOk(await request("PATCH", `/repos/${full_name}/issues/comments/${existing.id}`, { body }), "違反のコメントを書き直す")
    }
}

// タイトルと本文を検査し、PR ならステータスを付け、違反をコメントにまとめる
export const checkConventions = async (request: GitHubRequest, target: CheckTarget): Promise<string[]> => {
    const full_name = `${target.owner}/${target.repository}`
    const conventions = await readConventions(request, full_name)
    const violations = findViolations(conventions, target.kind, target.title, target.body)
    if (target.head_sha !== undefined) {
        expectOk(await request("POST", `/repos/${full_name}/statuses/${target.head_sha}`, {
            state: violations.length === 0 ? "success" : "failure",
            context: status_context,
            // description は 140 文字まで。詳しい内容はコメントに書く
            description: violations.length === 0 ? "タイトルと本文が規約に合っている" : `規約の違反が ${violations.length} 件ある。PR のコメントを見る`,
        }), "ステータスを付ける")
    }
    await updateReport(request, target, violations)
    return violations
}
