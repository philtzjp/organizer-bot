// .github/conventions.yml の規約で文字列を検査する。GitHub にも git にも触らない
import { readFileSync } from "node:fs"
import { parse } from "yaml"

type ForbiddenPattern = {
    pattern: string
    message: string
}

type Signature = {
    required: boolean
    pattern: string
    example: string
}

type BodyRules = {
    title_like_commit: boolean
    signature: Signature
    sections: string[]
    optional_sections: string[]
    task_list_section: string
    // すべての行を - の箇条書きで書く欄。字下げした行とコードブロックの中は問わない
    list_sections?: string[]
    // 決めた欄のほかの見出しと、## のほかの深さの見出しを書かない
    forbid_unknown_sections?: boolean
    // 署名と最初の見出しの間に文を書かない
    forbid_preamble?: boolean
}

export type Conventions = {
    commit: {
        types: string[]
        merge_type: string
        scope: "forbidden" | "optional" | "required"
        scope_from_paths: boolean
        leaf_parents: string[]
        repository_scope: string
        require_japanese: boolean
        single_line: boolean
        forbid_issue_numbers: boolean
        forbid_parentheses: boolean
        allowed_git_subjects: {
            merge: string
            local_only: string
        }
        initial_subject: string
        forbid_patterns: ForbiddenPattern[]
        semantic_lint: {
            enabled: boolean
            model: string
        }
    }
    tag: {
        pattern: string
        example: string
    }
    common: {
        forbid_co_authored_by: boolean
        forbid_patterns: ForbiddenPattern[]
    }
    subject: {
        forbid_emoji: boolean
    }
    issue: BodyRules
    pull_request: BodyRules & {
        forbid_closing_keywords: boolean
    }
    footers: { name: string, pattern: string }[]
    deleted_bot_comments: string[]
}

export const loadConventions = (path: string): Conventions => parse(readFileSync(path, "utf8")) as Conventions

// © や ™ のような記号は文中で使うので絵文字として扱わない
const emoji_pattern = /(?![©®™])\p{Extended_Pictographic}/u
const co_authored_by_pattern = /co-authored-by:/i
// GitHub が Issue を自動で閉じるキーワード
const closing_keyword_pattern = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s+([\w.-]+\/[\w.-]+)?#\d+/i

const stripCode = (text: string): string =>
    text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "")

const checkForbiddenPatterns = (patterns: ForbiddenPattern[], text: string): string[] =>
    patterns
        .filter((forbidden) => new RegExp(forbidden.pattern, "iu").test(text))
        .map((forbidden) => forbidden.message)

// コミットメッセージにも本文にも共通する検査
const checkText = (conventions: Conventions, text: string): string[] => [
    ...(conventions.common.forbid_co_authored_by && co_authored_by_pattern.test(text) ? ["Co-Authored-By を書かない"] : []),
    ...checkForbiddenPatterns(conventions.common.forbid_patterns, text),
]

// 変更したファイルから scope を 1 つ決める。決まらないときは空文字を返す
const scopeOfPath = (conventions: Conventions, path: string): string => {
    const segments = path.split("/")
    if (segments.length === 1) {
        return ""
    }
    const [top, leaf] = segments
    // stacks や packages そのものは scope にしないので、直下のファイルはリポジトリ直下と同じに扱う
    if (top !== undefined && conventions.commit.leaf_parents.includes(top)) {
        return segments.length > 2 && leaf !== undefined ? leaf : ""
    }
    return top ?? ""
}

export const allowedScope = (conventions: Conventions, paths: string[]): string => {
    const scopes = new Set(paths.map((path) => scopeOfPath(conventions, path)))
    const [only] = scopes
    return scopes.size === 1 && only !== undefined && only !== "" ? only : conventions.commit.repository_scope
}

// コミットメッセージの件名の形を検査する。Issue と PR のタイトルにも使う。
// is_merge は main に入るコミットで、type を merge に限る。
// changed_paths を渡すと、scope が変更したディレクトリと合っているかも見る
export const checkSubject = (
    conventions: Conventions,
    subject: string,
    is_merge: boolean,
    changed_paths?: string[],
): string[] => {
    const rules = conventions.commit
    const errors: string[] = []
    if (conventions.subject.forbid_emoji && emoji_pattern.test(subject)) {
        errors.push("絵文字を使わない")
    }
    const match = subject.match(/^([a-z]+)(\(([^)]*)\))?: (.*)$/)
    if (!match) {
        return [...errors, `「type(scope): 説明」の形にする: ${subject}`]
    }
    const [, type = "", scope_part, scope, description = ""] = match

    if (is_merge && type !== rules.merge_type) {
        errors.push(`main に入るコミットの type は ${rules.merge_type} にする`)
    }
    if (!is_merge && type === rules.merge_type) {
        errors.push(`${rules.merge_type} は main に入るコミットだけに使う`)
    }
    if (!is_merge && !rules.types.includes(type)) {
        errors.push(`type は ${rules.types.join(" / ")} のどれかにする: ${type}`)
    }
    if (rules.scope === "forbidden" && scope_part !== undefined) {
        errors.push("scope を付けない")
    }
    if (rules.scope === "required" && scope_part === undefined) {
        errors.push("type(scope): 説明 の形にし、scope を付ける")
    }
    if (scope !== undefined && (scope.includes("/") || scope === "")) {
        errors.push("scope は 1 つのディレクトリ名にする。スラッシュで階層を書かない")
    }
    if (rules.scope_from_paths && scope && changed_paths && changed_paths.length > 0) {
        const allowed = allowedScope(conventions, changed_paths)
        if (scope !== allowed) {
            errors.push(`scope は変更したディレクトリに合わせて ${allowed} にする: ${scope}`)
        }
    }
    if (description.trim() === "") {
        errors.push("説明を書く")
    }
    if (rules.require_japanese && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(description)) {
        errors.push("説明は日本語で書く")
    }
    if (rules.forbid_issue_numbers && /#\d+/.test(description)) {
        errors.push("説明に #N を書かない")
    }
    if (rules.forbid_parentheses && /[()（）[\]［］]/.test(description)) {
        errors.push("説明にカッコを書かない")
    }
    return errors
}

export type CommitContext = {
    // 親が 2 つ以上あるコミット
    is_merge: boolean
    // main に入ったコミット。bot が squash で作るので、親が 1 つでも type は merge にする
    on_main: boolean
    // 手元の hook から呼ぶとき。fixup と squash を通す
    is_local: boolean
    // 親のない最初のコミット。決まった件名だけを通す
    is_root?: boolean
    changed_paths?: string[]
}

// git が自動で付けた件名か。ベースブランチを取り込んだマージコミットと、手元の fixup と squash がこれにあたる
export const isGitGeneratedSubject = (conventions: Conventions, message: string, context: CommitContext): boolean => {
    const rules = conventions.commit
    const subject = message.replace(/\s+$/, "").split("\n")[0] ?? ""
    return (context.is_merge && new RegExp(rules.allowed_git_subjects.merge).test(subject))
        || (context.is_local && new RegExp(rules.allowed_git_subjects.local_only).test(subject))
}

export const checkCommitMessage = (conventions: Conventions, message: string, context: CommitContext): string[] => {
    const rules = conventions.commit
    const lines = message.replace(/\s+$/, "").split("\n")
    const subject = lines[0] ?? ""
    if (isGitGeneratedSubject(conventions, message, context)) {
        return context.is_merge ? checkText(conventions, message) : []
    }
    if (context.is_root === true && message.trim() === rules.initial_subject) {
        return checkText(conventions, message)
    }
    const errors = checkSubject(conventions, subject, context.is_merge || context.on_main, context.changed_paths)
    if (rules.single_line && lines.filter((line) => line.trim() !== "").length > 1) {
        errors.push("コミットメッセージは 1 行にし、本文を書かない")
    }
    return [
        ...errors,
        ...checkForbiddenPatterns(rules.forbid_patterns, message),
        ...checkText(conventions, message),
    ]
}

// ツールが本文に付けたフッターを取り除く。フッターがなければ本文をそのまま返す
export const stripFooters = (conventions: Conventions, body: string): { body: string, removed: string[] } => {
    let result = body
    const removed: string[] = []
    for (const footer of conventions.footers) {
        const stripped = result.replace(new RegExp(footer.pattern, "gu"), "")
        if (stripped !== result) {
            removed.push(footer.name)
            result = stripped
        }
    }
    if (removed.length === 0) {
        return { body, removed }
    }
    // フッターを取り除いたあとに残る、続いた空行と末尾の空白を詰める
    return { body: result.replace(/\n{3,}/g, "\n\n").replace(/\s+$/u, ""), removed }
}

const checkFooters = (conventions: Conventions, body: string): string[] =>
    stripFooters(conventions, body).removed.map((name) => `${name} のフッターを書かない`)

// 先頭行の署名を検査し、署名を除いた本文を返す
const splitSignature = (rules: Signature, body: string): { errors: string[], rest: string } => {
    const lines = stripComments(body).replace(/^\s+/, "").split(/\r?\n/)
    if (new RegExp(rules.pattern, "u").test(lines[0] ?? "")) {
        const errors = lines.length > 1 && (lines[1] ?? "").trim() !== "" ? ["署名の次の行は空ける"] : []
        return { errors, rest: lines.slice(1).join("\n") }
    }
    return { errors: rules.required ? [`先頭行に署名を書く。例: ${rules.example}`] : [], rest: body }
}

type SplitBody = {
    sections: Map<string, string>
    // 最初の ## の見出しより前の行
    preamble: string
    // ## のほかの深さの見出し
    other_headings: string[]
    // 2 回書いた欄の名前
    duplicates: string[]
}

// ## の見出しで本文を欄に分ける。コードブロックの中の行は見出しとして扱わない
const splitSections = (body: string): SplitBody => {
    const sections = new Map<string, string>()
    const other_headings: string[] = []
    const duplicates: string[] = []
    let preamble = ""
    let current: string | undefined
    let in_fence = false
    for (const line of stripComments(body).split(/\r?\n/)) {
        if (/^\s*```/.test(line)) {
            in_fence = !in_fence
        }
        const heading = in_fence ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
        if (heading?.[1] === "##" && heading[2] !== undefined) {
            current = heading[2]
            if (sections.has(current)) {
                duplicates.push(current)
            }
            sections.set(current, "")
        } else if (heading?.[2] !== undefined) {
            other_headings.push(line.trim())
        } else if (current !== undefined) {
            sections.set(current, `${sections.get(current) ?? ""}${line}\n`)
        } else {
            preamble += `${line}\n`
        }
    }
    return { sections, preamble, other_headings, duplicates }
}

// 欄の中で、字下げしていない行のうち line_pattern に合わないものを返す。空行とコードブロックの中は問わない
const topLevelLinesNotMatching = (text: string, line_pattern: RegExp): string[] => {
    const lines: string[] = []
    let in_fence = false
    for (const line of text.split("\n")) {
        if (/^\s*```/.test(line)) {
            in_fence = !in_fence
            continue
        }
        if (in_fence || line.trim() === "" || /^\s/.test(line)) {
            continue
        }
        if (!line_pattern.test(line)) {
            lines.push(line)
        }
    }
    return lines
}

// 必須の欄がそろっているか、決めた順に並んでいるか、タスクリストがあるかを検査する
const checkSections = (body: string, rules: BodyRules): string[] => {
    const { sections, preamble, other_headings, duplicates } = splitSections(body)
    const errors = rules.sections
        .filter((name) => (sections.get(name) ?? "").trim() === "")
        .map((name) => `「${name}」の欄を書く`)
    const order = [...rules.sections, ...rules.optional_sections]
    const positions = [...sections.keys()].map((name) => order.indexOf(name)).filter((position) => position >= 0)
    if (positions.some((position, index) => index > 0 && position < (positions[index - 1] ?? 0))) {
        errors.push(`欄は ${order.join("、")} の順に書く`)
    }
    const task_list = sections.get(rules.task_list_section) ?? ""
    if (!/^\s*- \[[ xX]\] \S/m.test(task_list) || topLevelLinesNotMatching(task_list, /^- \[[ xX]\] \S/).length > 0) {
        errors.push(`「${rules.task_list_section}」は、すべての行を - [ ] のタスクリストで書く`)
    }
    for (const name of rules.list_sections ?? []) {
        if (topLevelLinesNotMatching(sections.get(name) ?? "", /^- \S/).length > 0) {
            errors.push(`「${name}」は、すべての行を - の箇条書きで書く`)
        }
    }
    if (rules.forbid_unknown_sections) {
        const unknown = [...sections.keys()].filter((name) => !order.includes(name))
        if (unknown.length > 0) {
            errors.push(`決まっていない欄を書かない: ${unknown.join("、")}。欄は ${order.join("、")} だけにする`)
        }
        if (other_headings.length > 0) {
            errors.push(`見出しは ## だけを使う: ${other_headings.join("、")}`)
        }
        if (duplicates.length > 0) {
            errors.push(`同じ欄を 2 回書かない: ${[...new Set(duplicates)].join("、")}`)
        }
    }
    if (rules.forbid_preamble) {
        // 署名の行を除き、最初の見出しより前に文があれば止める
        const signature = new RegExp(rules.signature.pattern, "u")
        if (preamble.split("\n").some((line) => line.trim() !== "" && !signature.test(line))) {
            errors.push("署名と最初の見出しの間に文を書かない")
        }
    }
    return errors
}

const checkBody = (conventions: Conventions, rules: BodyRules, title: string, body: string): string[] => {
    const errors: string[] = []
    if (rules.title_like_commit) {
        errors.push(...checkSubject(conventions, title, false).map((error) => `タイトル: ${error}`))
    }
    const signature = splitSignature(rules.signature, body)
    return [...errors, ...signature.errors, ...checkSections(body, rules), ...checkText(conventions, body), ...checkFooters(conventions, body)]
}

export const checkIssue = (conventions: Conventions, title: string, body: string): string[] =>
    checkBody(conventions, conventions.issue, title, body)

export const checkPullRequest = (conventions: Conventions, title: string, body: string): string[] => {
    const rules = conventions.pull_request
    const errors = checkBody(conventions, rules, title, body)
    if (rules.forbid_closing_keywords && closing_keyword_pattern.test(stripCode(stripComments(body)))) {
        errors.push("Closes #N などで Issue を自動で閉じない。Issue はマージ後に手で閉じる")
    }
    return errors
}

export const checkTag = (conventions: Conventions, name: string): string[] =>
    new RegExp(conventions.tag.pattern, "u").test(name)
        ? []
        : [`tag は v を付けた semver にする。例: ${conventions.tag.example}: ${name}`]

// 説明に中身があるかを AI に判定させるときの指示。type と scope は規則の検査がファイルから確かめるので、
// AI には件名の説明の部分だけを渡し、具体的な変更が書かれているかだけを判定させる
export const semanticLintPrompt = (message: string): string => {
    const subject = message.split("\n")[0] ?? ""
    const description = subject.match(/^[a-z]+(\([^)]*\))?: (.+)$/)?.[2] ?? subject
    return [
        "You are a strict commit message linter. Respond with ONLY 'PASS' or 'FAIL: reason in Japanese'.",
        "",
        "You receive only the description part of a commit subject. The type and scope were already checked by other rules, so do not judge them, and do not mention them in your reason.",
        "",
        "Rules:",
        "- The description MUST clearly describe a specific change (what was changed and/or why)",
        "- FAIL if the description is meaningless, nonsensical, placeholder-like, or does not describe an actual change",
        "- FAIL examples: 'a', 'test', 'update', 'changes', 'main の変更を取り込む'",
        "- PASS examples: 'チームの親を宣言の順に作る', '命名規則を追加する', 'Environment を消す準備として protect を外せるようにする'",
        "",
        `Description: ${description}`,
    ].join("\n")
}
