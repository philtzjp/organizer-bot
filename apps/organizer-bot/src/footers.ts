import { findDeletedComment, stripFooters } from "@philtz/conventions/rules"
import { readConventions } from "./conventions.ts"
import { expectOk, type GitHubRequest } from "./github.ts"

// フッターを取り除く対象。Issue と PR は本文、コメントはコメントの本文
export type FooterTarget = {
    owner: string
    repository: string
    kind: "issue" | "pull_request" | "comment"
    // Issue と PR は番号、コメントは ID
    id: number
    body: string
    author: string
}

export type FooterResult = "unchanged" | "stripped" | "deleted"

// ツールのフッターを本文から取り除く。消すと決めた bot のコメントと、規約の deleted_comments の形に当たるコメントは丸ごと消す。
// 書き換えると edited のイベントがもう一度届くが、そのときはフッターがないので何もしない
export const cleanFooters = async (request: GitHubRequest, target: FooterTarget): Promise<FooterResult> => {
    const full_name = `${target.owner}/${target.repository}`
    const conventions = await readConventions(request, full_name)
    if (target.kind === "comment" && (conventions.deleted_bot_comments.includes(target.author) || findDeletedComment(conventions, target.body) !== undefined)) {
        const response = await request("DELETE", `/repos/${full_name}/issues/comments/${target.id}`)
        // すでに消えているときは 404 になる
        if (response.status !== 404) {
            expectOk(response, "コメントを消す")
        }
        return "deleted"
    }
    const { body, removed } = stripFooters(conventions, target.body)
    if (removed.length === 0) {
        return "unchanged"
    }
    const path = {
        issue: `/repos/${full_name}/issues/${target.id}`,
        pull_request: `/repos/${full_name}/pulls/${target.id}`,
        comment: `/repos/${full_name}/issues/comments/${target.id}`,
    }[target.kind]
    expectOk(await request("PATCH", path, { body }), "フッターを取り除く")
    return "stripped"
}
