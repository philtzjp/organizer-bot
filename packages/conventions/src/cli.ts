// 書式の検査の入口。
//   node packages/conventions/src/cli.ts commit-msg <ファイル>   手元の commit-msg hook から呼ぶ
//   node packages/conventions/src/cli.ts github                  Actions から呼ぶ。GITHUB_EVENT_NAME で分ける
//   node .agents/skills/conventions/cli.mjs commit-msg <ファイル> conventions スキルを入れた各リポジトリの hook から呼ぶ。
//                                                                  pnpm run build で skill/cli.mjs にまとめたもの
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { checkCommitMessage, checkIssue, isGitGeneratedSubject, checkPullRequest, checkTag, loadConventions } from "./rules.ts"

// 規約のファイルは、CONVENTIONS_PATH、作業中のリポジトリの .github/conventions.yml、この CLI の隣の conventions.yml の順に探す。
// 隣のものは、philtzjp/skills の conventions スキルとして配った CLI が使う
const conventions_path = process.env.CONVENTIONS_PATH
    ?? (existsSync(".github/conventions.yml") ? ".github/conventions.yml" : fileURLToPath(new URL("conventions.yml", import.meta.url)))
const conventions = loadConventions(conventions_path)

const report = (errors: string[], context: string): boolean => {
    if (errors.length === 0) {
        return true
    }
    console.error(context)
    for (const error of errors) {
        console.error(`  - ${error}`)
    }
    return false
}

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim()

// 説明に中身があるかを claude -p で判定する。claude がなければ codex exec で判定し、
// どちらもないときや判定に失敗したときは通す
const lintSemantically = (message: string): string[] => {
    const rules = conventions.commit.semantic_lint
    if (!rules.enabled) {
        return []
    }
    const prompt = [
        "You are a strict commit message linter. Respond with ONLY 'PASS' or 'FAIL: reason in Japanese'.",
        "",
        "Rules:",
        "- Format: type(scope): description",
        "- Description MUST clearly describe a specific change (what was changed and/or why)",
        "- FAIL if the description is meaningless, nonsensical, placeholder-like, or does not describe an actual change",
        "- FAIL examples: 'fix(repo): a', 'feat(repo): test', 'fix(repo): update', 'chore(repo): changes'",
        "- PASS examples: 'fix(github): チームの親を宣言の順に作る', 'docs(docs): 命名規則を追加する'",
        "",
        `Message: ${message}`,
    ].join("\n")
    const runClaude = (): string =>
        execFileSync("claude", ["-p", "--model", rules.model, prompt], {
            encoding: "utf8",
            timeout: 60_000,
            stdio: ["ignore", "pipe", "ignore"],
        }).trim()
    const runCodex = (): string => {
        const directory = mkdtempSync(join(tmpdir(), "conventions-"))
        const output = join(directory, "last-message.txt")
        try {
            execFileSync("codex", ["exec", "--output-last-message", output, prompt], {
                timeout: 120_000,
                stdio: ["ignore", "ignore", "ignore"],
            })
            return readFileSync(output, "utf8").trim()
        } finally {
            rmSync(directory, { recursive: true, force: true })
        }
    }
    let result = ""
    for (const run of [runClaude, runCodex]) {
        try {
            result = run()
        } catch {
            result = ""
        }
        if (result !== "") {
            break
        }
    }
    if (result === "" || result.startsWith("PASS")) {
        return []
    }
    return [result.replace(/^FAIL:\s*/, "").replace(/\s+/g, " ")]
}

const runCommitMessage = (path: string): boolean => {
    // git のコメント行を除いてから検査する
    const message = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n")
        .trim()
    const is_merge = existsSync(git("rev-parse", "--git-path", "MERGE_HEAD"))
    const changed_paths = git("diff", "--cached", "--name-only").split("\n").filter((line) => line !== "")
    const context = { is_merge, on_main: false, is_local: true, changed_paths }
    const errors = checkCommitMessage(conventions, message, context)
    // git が自動で付けた件名は type(scope): 説明 の形ではないので、説明の中身の判定にかけない
    if (errors.length === 0 && !isGitGeneratedSubject(conventions, message, context)) {
        errors.push(...lintSemantically(message))
    }
    return report(errors, `コミットメッセージが規約に合っていません: ${message.split("\n")[0] ?? ""}`)
}

// ここから Actions 用

const api_url = process.env.GITHUB_API_URL ?? "https://api.github.com"
const repository = process.env.GITHUB_REPOSITORY ?? ""

const github = async (path: string): Promise<Response> => {
    const response = await fetch(path.startsWith("http") ? path : `${api_url}${path}`, {
        headers: {
            authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
        },
    })
    if (!response.ok) {
        throw new Error(`GET ${path}: ${response.status} ${await response.text()}`)
    }
    return response
}

type CommitDetail = {
    sha: string
    commit: { message: string }
    parents: unknown[]
    files?: { filename: string }[]
}


const checkCommit = async (sha: string): Promise<boolean> => {
    const detail = await (await github(`/repos/${repository}/commits/${sha}`)).json() as CommitDetail
    const message = detail.commit.message
    return report(
        checkCommitMessage(conventions, message, {
            is_merge: detail.parents.length > 1,
            on_main: true,
            is_local: false,
            is_root: detail.parents.length === 0,
            changed_paths: (detail.files ?? []).map((file) => file.filename),
        }),
        `コミット ${sha.slice(0, 7)} ${message.split("\n")[0] ?? ""}`,
    )
}

type PullRequest = { number: number, title: string, body: string | null }
type Issue = { number: number, title: string, body: string | null, pull_request?: unknown }
type PushEvent = { ref?: string, deleted?: boolean, commits?: { id: string }[] }

// PR の途中のコミットは squash で main に残らないので、タイトルと本文だけを検査する
const checkPullRequestEvent = (pull_request: PullRequest): boolean => report(
    checkPullRequest(conventions, pull_request.title, pull_request.body ?? ""),
    `PR #${pull_request.number} のタイトルと本文`,
)

const checkPushEvent = async (event: PushEvent): Promise<boolean> => {
    // tag の push では tag の名前だけを見る。消したときは見ない
    if (event.ref?.startsWith("refs/tags/") === true) {
        return event.deleted === true || report(checkTag(conventions, event.ref.slice("refs/tags/".length)), `tag ${event.ref}`)
    }
    let ok = true
    for (const commit of event.commits ?? []) {
        ok = await checkCommit(commit.id) && ok
    }
    return ok
}

const runGitHub = async (): Promise<boolean> => {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")) as {
        pull_request?: PullRequest
        issue?: Issue
    } & PushEvent
    switch (process.env.GITHUB_EVENT_NAME) {
        case "pull_request":
            return event.pull_request === undefined || checkPullRequestEvent(event.pull_request)
        case "issues":
            return event.issue === undefined || report(
                checkIssue(conventions, event.issue.title, event.issue.body ?? ""),
                `Issue #${event.issue.number} のタイトルと本文`,
            )
        case "push":
            return checkPushEvent(event)
        default:
            console.log(`${process.env.GITHUB_EVENT_NAME ?? ""} は検査しません`)
            return true
    }
}

const [mode, argument] = process.argv.slice(2)
const ok = mode === "commit-msg" && argument !== undefined ? runCommitMessage(argument) : await runGitHub()
process.exit(ok ? 0 : 1)
