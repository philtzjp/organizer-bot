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

// requested は、GitHub にマージを頼んだこと。merged ならマージ済み、pending なら GitHub が後でマージする
export type MergeResult =
    | { status: "merged", sha: string }
    | { status: "pending", uuid: string }
    | { status: "refused", reasons: string[] }

// 頼んだマージの結果。pending のままなら、PR がマージされたイベントで片付ける
export type AsyncMergeStatus =
    | { status: "merged", sha: string }
    | { status: "failed", message: string }
    | { status: "pending" }

type PullRequest = {
    state: string
    draft: boolean
    title: string
    body: string | null
    user: { login: string }
    head: { ref: string, sha: string, repo: { full_name: string } | null }
    base: { ref: string, repo: { full_name: string, default_branch: string } }
}

type CheckRun = { id?: number, name: string, status: string, conclusion: string | null, app: { id: number } | null }
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

type WorkflowRun = { id: number, name: string, status: string, conclusion: string | null }

// 名前ごとに、id のいちばん大きいもの、つまりいちばん新しいものを残す
export const latestByName = <T extends { id?: number, name: string }>(items: T[]): T[] => {
    const latest = new Map<string, T>()
    for (const item of items) {
        const current = latest.get(item.name)
        if (current === undefined || (item.id ?? 0) > (current.id ?? 0)) {
            latest.set(item.name, item)
        }
    }
    return [...latest.values()]
}

// 必須の検査が決まっていないリポジトリでは、PR の head に付いたものを全部待つ。
// 検査、GitHub Actions の workflow の実行、commit status のどれかが終わっていないか失敗していれば、マージしない。
// push の直後で workflow の実行がまだ作られていないときは見逃すが、作られたものは必ず待つ
const checkAllChecks = async (request: GitHubRequest, full_name: string, sha: string, check_runs: CheckRun[], statuses: CommitStatus[]): Promise<string[]> => {
    const workflow_runs = (expectOk(await request("GET", `/repos/${full_name}/actions/runs?head_sha=${sha}&per_page=100`), "workflow の実行を読む") as { workflow_runs: WorkflowRun[] }).workflow_runs
    const reasons: string[] = []
    // 同じ名前のものは、いちばん新しいものだけを見る。workflow の concurrency で取り消された前の実行を、失敗に数えない
    for (const run of latestByName(check_runs)) {
        if (run.status !== "completed") {
            reasons.push(`検査 ${run.name} がまだ終わっていない`)
        } else if (!passing_conclusions.has(run.conclusion ?? "")) {
            reasons.push(`検査 ${run.name} が失敗している`)
        }
    }
    for (const run of latestByName(workflow_runs)) {
        if (run.status !== "completed") {
            reasons.push(`workflow ${run.name} がまだ終わっていない`)
        } else if (!passing_conclusions.has(run.conclusion ?? "")) {
            reasons.push(`workflow ${run.name} が失敗している`)
        }
    }
    for (const status of statuses) {
        if (status.state === "pending") {
            reasons.push(`検査 ${status.context} がまだ終わっていない`)
        } else if (status.state !== "success") {
            reasons.push(`検査 ${status.context} が失敗している`)
        }
    }
    // 同じ名前の検査と workflow は、理由を 1 つにまとめる
    return [...new Set(reasons)]
}

const checkRequiredChecks = async (request: GitHubRequest, full_name: string, branch: string, sha: string, rules: BranchRule[]): Promise<string[]> => {
    const required = await readRequiredChecks(request, full_name, branch, rules)
    const check_runs = await readAll<CheckRun>(request, `/repos/${full_name}/commits/${sha}/check-runs`, (body) => (body as { check_runs: CheckRun[] }).check_runs)
    const statuses = (expectOk(await request("GET", `/repos/${full_name}/commits/${sha}/status`), "commit status を読む") as { statuses: CommitStatus[] }).statuses
    if (required.length === 0) {
        return checkAllChecks(request, full_name, sha, check_runs, statuses)
    }
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
        reasons.push("fork からの PR はマージしない")
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
        return { status: "refused", reasons }
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
        return { status: "refused", reasons }
    }

    // scope は変更したファイルから決める。名前を変えたファイルは、元の場所も変更したものとして数える
    const files = await readAll<{ filename: string, previous_filename?: string }>(request, `/repos/${full_name}/pulls/${target.number}/files`, (body) => body as { filename: string }[])
    const paths = files.flatMap((file) => file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename])
    const subject = `${conventions.commit.merge_type}(${allowedScope(conventions, paths)}): ${description}`

    // GitHub にマージを頼む。ブランチは書き換えず、author は PR を出した人、committer は GitHub になる。
    // 本文は空にし、GitHub が付ける (#N) と Co-authored-by を入れない。sha を渡すので、頼んだあとに push されたら GitHub が取り消す。
    // bot はデフォルトブランチの ruleset の例外に入っているので、ruleset はすり抜ける。必須の検査と承認は、上で bot が確かめた
    const response = await request("PUT", `/repos/${full_name}/pulls/${target.number}/merge-async`, {
        merge_method: "squash",
        merge_action: "direct_merge",
        commit_title: subject,
        commit_message: "",
        sha: head_sha,
        bypass_rules: true,
    })
    const body = response.body as { status?: string, sha?: string, details?: { uuid?: string, message?: string, sha?: string } } | undefined
    if ((response.status === 200 || response.status === 202 || response.status === 409) && body?.status === "merged") {
        return { status: "merged", sha: body.sha ?? body.details?.sha ?? "" }
    }
    if ((response.status === 202 || response.status === 409) && body?.details?.uuid !== undefined) {
        return { status: "pending", uuid: body.details.uuid }
    }
    return { status: "refused", reasons: [`GitHub がマージを受け付けなかった: ${response.status} ${body?.details?.message ?? JSON.stringify(response.body)}`] }
}

// 頼んだマージの結果を、決まった回数だけ問い合わせる。結果は GitHub に 24 時間残る
export const waitForMerge = async (
    request: GitHubRequest,
    target: PullRequestTarget,
    uuid: string,
    attempts = 10,
    wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<AsyncMergeStatus> => {
    const full_name = `${target.owner}/${target.repository}`
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const body = expectOk(await request("GET", `/repos/${full_name}/pulls/${target.number}/merge-async/${uuid}`), "マージの結果を読む") as { status: string, sha?: string, details?: { message?: string, sha?: string } }
        if (body.status === "merged") {
            return { status: "merged", sha: body.sha ?? body.details?.sha ?? "" }
        }
        if (body.status === "failed") {
            return { status: "failed", message: body.details?.message ?? "理由はわからない" }
        }
        await wait(2000)
    }
    return { status: "pending" }
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
