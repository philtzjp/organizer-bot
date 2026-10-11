import { allowedScope } from "@philtz/conventions/rules"
import { findViolations } from "./check.ts"
import { readConventions } from "./conventions.ts"
import { botCommitter, botSignature, expectOk, readAll, type GitHubRequest } from "./github.ts"
import { config } from "./config.ts"

// PR をマージさせる合図のラベル
export const merge_label = "merge"

export type PullRequestTarget = {
    owner: string
    repository: string
    number: number
}

export type MergeRequest = PullRequestTarget & {
    // merge ラベルを付けた人
    labeled_by: string
}

// pushed は、squash のコミットまで PR のブランチを進めたこと。main は synchronize のイベントを受けてから進める
export type MergeResult =
    | { pushed: true, sha: string }
    | { pushed: false, reasons: string[] }

export type AdvanceResult =
    | { status: "advanced", sha: string }
    | { status: "refused", reasons: string[] }
    // ボットが作った squash のコミットではないので、何もしない
    | { status: "ignored" }

type PullRequest = {
    state: string
    draft: boolean
    title: string
    body: string | null
    user: { login: string }
    head: { ref: string, sha: string, repo: { full_name: string } | null }
    base: { ref: string, repo: { full_name: string, default_branch: string } }
}

type CheckRun = { name: string, status: string, conclusion: string | null, app: { id: number } | null }
type CommitStatus = { context: string, state: string }
type BranchRule = {
    type: string
    parameters?: {
        required_status_checks?: { context: string, integration_id?: number }[]
        required_approving_review_count?: number
        dismiss_stale_reviews_on_push?: boolean
    }
}
type Review = { user: { login: string } | null, state: string, commit_id: string }

const passing_conclusions = new Set(["success", "neutral", "skipped"])

const readBranchRules = async (request: GitHubRequest, full_name: string, branch: string): Promise<BranchRule[]> =>
    expectOk(await request("GET", `/repos/${full_name}/rules/branches/${encodeURIComponent(branch)}`), "ruleset を読む") as BranchRule[]

// ruleset と branch protection の両方から、必須の検査の名前を集める
const readRequiredChecks = async (request: GitHubRequest, full_name: string, branch: string, rules: BranchRule[]): Promise<{ context: string, integration_id?: number }[]> => {
    const from_rulesets = rules
        .filter((rule) => rule.type === "required_status_checks")
        .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    const protection = await request("GET", `/repos/${full_name}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`)
    const from_protection = protection.status === 200
        ? ((protection.body as { checks?: { context: string, app_id: number | null }[] }).checks ?? [])
            .map((check) => ({ context: check.context, ...(check.app_id === null ? {} : { integration_id: check.app_id }) }))
        : []
    return [...from_rulesets, ...from_protection]
}

const checkRequiredChecks = async (request: GitHubRequest, full_name: string, branch: string, sha: string, rules: BranchRule[]): Promise<string[]> => {
    const required = await readRequiredChecks(request, full_name, branch, rules)
    if (required.length === 0) {
        return []
    }
    const check_runs = await readAll<CheckRun>(request, `/repos/${full_name}/commits/${sha}/check-runs`, (body) => (body as { check_runs: CheckRun[] }).check_runs)
    const statuses = (expectOk(await request("GET", `/repos/${full_name}/commits/${sha}/status`), "commit status を読む") as { statuses: CommitStatus[] }).statuses
    const reasons: string[] = []
    for (const check of required) {
        const runs = check_runs.filter((run) => run.name === check.context && (check.integration_id === undefined || run.app?.id === check.integration_id))
        const status = statuses.find((candidate) => candidate.context === check.context)
        if (runs.some((run) => run.status === "completed" && passing_conclusions.has(run.conclusion ?? "")) || status?.state === "success") {
            continue
        }
        if (runs.some((run) => run.status !== "completed") || status?.state === "pending" || (runs.length === 0 && status === undefined)) {
            reasons.push(`必須の検査 ${check.context} がまだ終わっていない`)
        } else {
            reasons.push(`必須の検査 ${check.context} が失敗している`)
        }
    }
    return reasons
}

// bot は ruleset を bypass してデフォルトブランチを進めるので、承認の条件も bot が確かめる
const checkApprovals = async (
    request: GitHubRequest,
    full_name: string,
    branch: string,
    number: number,
    author: string,
    head_sha: string,
    rules: BranchRule[],
): Promise<string[]> => {
    const protection = await request("GET", `/repos/${full_name}/branches/${encodeURIComponent(branch)}/protection/required_pull_request_reviews`)
    const legacy = protection.status === 200
        ? protection.body as { required_approving_review_count?: number, dismiss_stale_reviews?: boolean }
        : undefined
    const pull_request_rules = rules.filter((rule) => rule.type === "pull_request").map((rule) => rule.parameters ?? {})
    const required = Math.max(0, legacy?.required_approving_review_count ?? 0, ...pull_request_rules.map((rule) => rule.required_approving_review_count ?? 0))
    if (required === 0) {
        return []
    }
    const dismiss_stale = legacy?.dismiss_stale_reviews === true || pull_request_rules.some((rule) => rule.dismiss_stale_reviews_on_push === true)
    const reviews = await readAll<Review>(request, `/repos/${full_name}/pulls/${number}/reviews`, (body) => body as Review[])
    // 人ごとに、承認か変更要求か取り消しの最後のものを取る。コメントだけのレビューは状態を変えない
    const latest = new Map<string, Review>()
    for (const review of reviews) {
        const login = review.user?.login
        if (login === undefined || login === author || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
            continue
        }
        latest.set(login, review)
    }
    const approvals = [...latest.values()].filter((review) => review.state === "APPROVED" && (!dismiss_stale || review.commit_id === head_sha)).length
    return approvals >= required ? [] : [`承認が ${required} 件要るが、${approvals} 件しかない`]
}

// 件名の説明の部分を PR のタイトルから取り出す。タイトルは type(scope): 説明 の形
const readDescription = (title: string): string | undefined => title.match(/^[a-z]+(\([^)]*\))?: (.+)$/)?.[2]

// org の owner は、承認がなくてもマージさせてよいと決めている
const isOrganizationOwner = async (request: GitHubRequest, organization: string, login: string): Promise<boolean> => {
    const response = await request("GET", `/orgs/${organization}/memberships/${encodeURIComponent(login)}`)
    if (response.status === 404) {
        return false
    }
    const membership = expectOk(response, "ラベルを付けた人の role を読む") as { role: string, state: string }
    return membership.role === "admin" && membership.state === "active"
}

export const mergePullRequest = async (request: GitHubRequest, target: MergeRequest): Promise<MergeResult> => {
    const full_name = `${target.owner}/${target.repository}`
    const pull_request = expectOk(await request("GET", `/repos/${full_name}/pulls/${target.number}`), "PR を読む") as PullRequest

    const reasons: string[] = []
    if (pull_request.state !== "open") {
        reasons.push("PR が開いていない")
    }
    if (pull_request.draft) {
        reasons.push("PR が Draft のまま")
    }
    if (pull_request.head.repo?.full_name !== full_name) {
        reasons.push("fork からの PR は bot がブランチを書き換えられない")
    }
    if (pull_request.base.ref !== pull_request.base.repo.default_branch) {
        reasons.push(`マージ先が ${pull_request.base.repo.default_branch} ではない`)
    }
    const description = readDescription(pull_request.title)
    if (description === undefined) {
        reasons.push("PR のタイトルが type(scope): 説明 の形になっていない")
    }
    const conventions = await readConventions(request, full_name)
    reasons.push(...findViolations(conventions, "pull_request", pull_request.title, pull_request.body ?? ""))
    if (reasons.length > 0) {
        return { pushed: false, reasons }
    }

    // PR が読まれたあとに main が進んでいることがあるので、main の先頭を読み直す
    const base_ref = expectOk(await request("GET", `/repos/${full_name}/git/ref/heads/${encodeURIComponent(pull_request.base.ref)}`), "main の先頭を読む") as { object: { sha: string } }
    const base_sha = base_ref.object.sha
    const head_sha = pull_request.head.sha
    // push の直後は、PR の head がまだ古いコミットを指していることがある。そのまま squash すると、新しいコミットが入らない。
    // ブランチの先頭と PR の head が同じときだけ進める
    const head_ref = expectOk(await request("GET", `/repos/${full_name}/git/ref/heads/${encodeURIComponent(pull_request.head.ref)}`), "PR のブランチの先頭を読む") as { object: { sha: string } }
    if (head_ref.object.sha !== head_sha) {
        reasons.push("PR の head がブランチの先頭にまだ追いついていない。GitHub が push を反映するのを待ってからラベルを付け直す")
    }
    const comparison = expectOk(await request("GET", `/repos/${full_name}/compare/${base_sha}...${head_sha}`), "main と PR を比べる") as { behind_by: number, ahead_by: number }
    if (comparison.behind_by > 0) {
        reasons.push(`ブランチが ${pull_request.base.ref} に追いついていない`)
    }
    if (comparison.ahead_by === 0) {
        reasons.push("PR に変更がない")
    }
    const rules = await readBranchRules(request, full_name, pull_request.base.ref)
    reasons.push(...await checkRequiredChecks(request, full_name, pull_request.base.ref, head_sha, rules))
    if (!await isOrganizationOwner(request, target.owner, target.labeled_by)) {
        reasons.push(...await checkApprovals(request, full_name, pull_request.base.ref, target.number, pull_request.user.login, head_sha, rules))
    }
    if (reasons.length > 0) {
        return { pushed: false, reasons }
    }

    // scope は変更したファイルから決める。名前を変えたファイルは、元の場所も変更したものとして数える
    const files = await readAll<{ filename: string, previous_filename?: string }>(request, `/repos/${full_name}/pulls/${target.number}/files`, (body) => body as { filename: string }[])
    const paths = files.flatMap((file) => file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename])
    const subject = `${conventions.commit.merge_type}(${allowedScope(conventions, paths)}): ${description}`

    // author は PR を出した人の noreply アドレスにする。GitHub はこのアドレスでアカウントに紐づける
    const author = expectOk(await request("GET", `/users/${encodeURIComponent(pull_request.user.login)}`), "PR を出した人を読む") as { id: number, login: string, name: string | null }
    const head_commit = expectOk(await request("GET", `/repos/${full_name}/git/commits/${head_sha}`), "PR の先頭のコミットを読む") as { tree: { sha: string } }

    // ブランチが main に追いついているので、PR の先頭のツリーがマージした結果になる。
    // committer を書かないと、GitHub は author を committer にも使う。author と committer を分けると署名は付かない
    const commit = expectOk(await request("POST", `/repos/${full_name}/git/commits`, {
        message: subject,
        tree: head_commit.tree.sha,
        parents: [base_sha],
        author: {
            name: author.name ?? author.login,
            email: `${author.id}+${author.login}@users.noreply.github.com`,
        },
        committer: botCommitter(),
    }), "squash のコミットを作る") as { sha: string }

    // PR のブランチの先頭と main の先頭を同じコミットにすると、GitHub は PR をマージ済みにする。
    // PR の head の更新が GitHub に反映される前に main を進めるとクローズになるので、main は synchronize のイベントを受けてから進める
    expectOk(await request("PATCH", `/repos/${full_name}/git/refs/heads/${encodeURIComponent(pull_request.head.ref)}`, { sha: commit.sha, force: true }), "PR のブランチを進める")
    return { pushed: true, sha: commit.sha }
}

// PR の head が、ボットが作り、親が main の先頭の squash のコミットなら、main をそこまで早送りで進める
export const advanceDefaultBranch = async (request: GitHubRequest, target: PullRequestTarget, base_ref: string, head_sha: string): Promise<AdvanceResult> => {
    const full_name = `${target.owner}/${target.repository}`
    const head_commit = expectOk(await request("GET", `/repos/${full_name}/git/commits/${head_sha}`), "PR の先頭のコミットを読む") as { committer: { email: string }, parents: { sha: string }[] }
    if (head_commit.committer.email !== botCommitter().email || head_commit.parents.length !== 1) {
        return { status: "ignored" }
    }
    const base = expectOk(await request("GET", `/repos/${full_name}/git/ref/heads/${encodeURIComponent(base_ref)}`), "main の先頭を読む") as { object: { sha: string } }
    // 同じ synchronize が 2 回届くことがある。先に届いたもので main を進め終わっていれば、何もしない
    if (base.object.sha === head_sha) {
        return { status: "ignored" }
    }
    if (head_commit.parents[0]!.sha !== base.object.sha) {
        return { status: "refused", reasons: [`squash のコミットを作ったあとに ${base_ref} が進んだ。ブランチを追いつかせてからラベルを付け直す`] }
    }
    const advanced = await request("PATCH", `/repos/${full_name}/git/refs/heads/${encodeURIComponent(base_ref)}`, { sha: head_sha, force: false })
    if (advanced.status < 200 || advanced.status >= 300) {
        return { status: "refused", reasons: [`${base_ref} を進められなかった。途中で ${base_ref} が進んだ可能性がある。ブランチを追いつかせてからラベルを付け直す`] }
    }
    return { status: "advanced", sha: head_sha }
}

// マージしなかった理由を PR に書き、ラベルを外す。ラベルを残すと、付け直しても合図にならないため
// マージを断ったコメントの目印。断るときは前のものを消してから置き、マージできたら消す
// 断ったコメントの目印。本番では <!-- <bot の login>:merge-refusal --> になる
const refusalMarker = (): string => `<!-- ${config.bot_login}:merge-refusal -->`
// 目印を付ける前に置いたコメントは、この文面で見分ける
const refusal_lead = "次の理由でマージしませんでした。"

type Comment = { id: number, body: string | null, user: { login: string } | null }

// ボットが書いた断ったコメントだけを対象にし、人が書いたものには触らない
export const isRefusalComment = (comment: Comment): boolean =>
    comment.user?.login === botCommitter().name
    && ((comment.body ?? "").includes(refusalMarker()) || (comment.body ?? "").includes(refusal_lead))

export const deleteRefusals = async (request: GitHubRequest, target: PullRequestTarget): Promise<void> => {
    const full_name = `${target.owner}/${target.repository}`
    const comments = await readAll<Comment>(request, `/repos/${full_name}/issues/${target.number}/comments`, (body) => body as Comment[])
    for (const comment of comments.filter(isRefusalComment)) {
        const response = await request("DELETE", `/repos/${full_name}/issues/comments/${comment.id}`)
        // すでに消えているときは 404 になる
        if (response.status !== 404) {
            expectOk(response, "断ったコメントを消す")
        }
    }
}

export const reportRefusal = async (request: GitHubRequest, target: PullRequestTarget, reasons: string[]): Promise<void> => {
    const full_name = `${target.owner}/${target.repository}`
    await deleteRefusals(request, target)
    const body = [botSignature(), "", refusalMarker(), `${refusal_lead}直してから \`merge\` ラベルを付け直してください。マージできたら、このコメントは消えます。`, "", ...reasons.map((reason) => `- ${reason}`)].join("\n")
    expectOk(await request("POST", `/repos/${full_name}/issues/${target.number}/comments`, { body }), "理由をコメントする")
    await removeMergeLabel(request, target)
}

export const removeMergeLabel = async (request: GitHubRequest, target: PullRequestTarget): Promise<void> => {
    const response = await request("DELETE", `/repos/${target.owner}/${target.repository}/issues/${target.number}/labels/${merge_label}`)
    // すでに外れているときは 404 になる
    if (response.status !== 404) {
        expectOk(response, "ラベルを外す")
    }
}
