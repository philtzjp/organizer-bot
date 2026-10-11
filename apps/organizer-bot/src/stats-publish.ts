// ファイルを、ボットがリポジトリのブランチに直接コミットする。統計の SVG と conventions スキルの写しに使う。
// 中身が前と同じファイルは書かず、変わったものがなければコミットしない
import { botCommitter, expectOk, type GitHubRequest } from "./github.ts"

export type PublishTarget = {
    owner: string
    repository: string
    branch: string
    // ファイルを置くディレクトリ。末尾の / は付けない
    directory: string
    // コミットメッセージ。.github/conventions.yml の規約に合わせる
    message: string
}

export const stats_message = "chore(images): 統計のグラフを更新"

// git が blob の sha を計算するのと同じ方法で、中身から sha を出す
export const blobSha = async (content: string): Promise<string> => {
    const bytes = new TextEncoder().encode(content)
    const header = new TextEncoder().encode(`blob ${bytes.length}\0`)
    const digest = await crypto.subtle.digest("SHA-1", new Uint8Array([...header, ...bytes]))
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export type PublishResult = { status: "committed", sha: string, changed: string[] } | { status: "unchanged" }

export const publishFiles = async (request: GitHubRequest, target: PublishTarget, files: Record<string, string>): Promise<PublishResult> => {
    const full_name = `${target.owner}/${target.repository}`
    const ref = expectOk(await request("GET", `/repos/${full_name}/git/ref/heads/${target.branch}`), "ブランチを読む") as { object: { sha: string } }
    const head = expectOk(await request("GET", `/repos/${full_name}/git/commits/${ref.object.sha}`), "先頭のコミットを読む") as { tree: { sha: string } }
    const tree = expectOk(await request("GET", `/repos/${full_name}/git/trees/${head.tree.sha}?recursive=1`), "ツリーを読む") as { tree: { path: string, sha: string }[] }
    const current = new Map(tree.tree.map((entry) => [entry.path, entry.sha]))

    const changed: { path: string, content: string }[] = []
    for (const [name, content] of Object.entries(files)) {
        const path = `${target.directory}/${name}`
        if (current.get(path) !== await blobSha(content)) {
            changed.push({ path, content })
        }
    }
    if (changed.length === 0) {
        return { status: "unchanged" }
    }

    const new_tree = expectOk(await request("POST", `/repos/${full_name}/git/trees`, {
        base_tree: head.tree.sha,
        tree: changed.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })),
    }), "ツリーを作る") as { sha: string }
    const commit = expectOk(await request("POST", `/repos/${full_name}/git/commits`, {
        message: target.message,
        tree: new_tree.sha,
        parents: [ref.object.sha],
        author: botCommitter(),
        committer: botCommitter(),
    }), "コミットを作る") as { sha: string }
    // 途中で誰かが進めていたら失敗させ、次の回に任せる
    expectOk(await request("PATCH", `/repos/${full_name}/git/refs/heads/${target.branch}`, { sha: commit.sha, force: false }), "ブランチを進める")
    return { status: "committed", sha: commit.sha, changed: changed.map((file) => file.path) }
}
