import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { allowedScope, checkCommitMessage, isGitGeneratedSubject, semanticLintPrompt, checkIssue, checkPullRequest, checkTag, loadConventions, stripFooters } from "./rules.ts"

const conventions = loadConventions(new URL("../fixtures/conventions.yml", import.meta.url).pathname)

const commit = (message: string, changed_paths?: string[], is_merge = false, is_local = false, on_main = false): string[] =>
    checkCommitMessage(conventions, message, { is_merge, on_main, is_local, ...(changed_paths === undefined ? {} : { changed_paths }) })

describe("コミットメッセージ", () => {
    it("main の最初のコミットは、決めた件名だけを通す", () => {
        const root = (message: string): string[] => checkCommitMessage(conventions, message, { is_merge: false, on_main: true, is_local: false, is_root: true, changed_paths: ["README.md"] })
        assert.deepEqual(root("chore(repo): リポジトリを初期化"), [])
        assert.ok(root("Initial commit").length > 0)
        assert.ok(commit("chore(repo): リポジトリを初期化", ["README.md"], false, false, true).length > 0)
    })

    it("git が付けたマージと fixup の件名を見分ける", () => {
        const local = { is_merge: false, on_main: false, is_local: true }
        assert.equal(isGitGeneratedSubject(conventions, "Merge remote-tracking branch 'origin/main' into feat/1-x", { ...local, is_merge: true }), true)
        assert.equal(isGitGeneratedSubject(conventions, "fixup! docs(docs): 命名規則を追加する", local), true)
        assert.equal(isGitGeneratedSubject(conventions, "docs(docs): 命名規則を追加する", local), false)
        // マージでないコミットに Merge の件名を付けても、git が付けたものとは見なさない
        assert.equal(isGitGeneratedSubject(conventions, "Merge branch 'x'", local), false)
    })

    it("type(scope): 日本語の説明 を通す", () => {
        assert.deepEqual(commit("docs(docs): 命名規則を追加する"), [])
    })

    it("scope がないものを止める", () => {
        assert.ok(commit("docs: 命名規則を追加する").length > 0)
    })

    it("決めた type 以外を止める", () => {
        assert.ok(commit("update(docs): 命名規則を追加する").length > 0)
    })

    it("英語だけの説明を止める", () => {
        assert.ok(commit("docs(docs): add naming rules").length > 0)
    })

    it("説明のカッコを止める", () => {
        assert.ok(commit("docs(docs): 命名規則（案）を追加する").length > 0)
    })

    it("説明の #N を止める", () => {
        assert.ok(commit("docs(docs): #2 の命名規則を追加する").length > 0)
    })

    it("フェーズを止める", () => {
        assert.ok(commit("docs(docs): フェーズ 1 の命名規則を追加する").length > 0)
    })

    it("2 行以上を止める", () => {
        assert.ok(commit("docs(docs): 命名規則を追加する\n\n本文").length > 0)
    })

    it("Co-Authored-By を止める", () => {
        assert.ok(commit("docs(docs): 命名規則を追加する\n\nCo-Authored-By: someone <a@example.com>").length > 0)
    })

    it("件名の絵文字を止める", () => {
        assert.ok(commit("docs(docs): 命名規則を追加する 🎉").length > 0)
    })

    it("マージコミットは merge の type だけを通す", () => {
        assert.deepEqual(commit("merge(repo): 基本方針を追加する", undefined, true), [])
        assert.ok(commit("docs(repo): 基本方針を追加する", undefined, true).length > 0)
        assert.ok(commit("merge(repo): 基本方針を追加する").length > 0)
    })

    it("main の親が 1 つのコミットは merge の type だけを通す", () => {
        assert.deepEqual(commit("merge(docs): 命名規則を追加する", ["docs/naming.md"], false, false, true), [])
        assert.ok(commit("docs(docs): 命名規則を追加する", ["docs/naming.md"], false, false, true).length > 0)
    })

    it("main のコミットの scope も変更したディレクトリと合わせる", () => {
        assert.ok(commit("merge(repo): 命名規則を追加する", ["docs/naming.md"], false, false, true).length > 0)
    })

    it("ベースブランチを取り込んだマージコミットを通す", () => {
        assert.deepEqual(commit("Merge remote-tracking branch 'origin/main' into feat/6-github-stack", undefined, true), [])
    })

    it("fixup は手元でだけ通す", () => {
        assert.deepEqual(commit("fixup! docs(docs): 命名規則を追加する", undefined, false, true), [])
        assert.ok(commit("fixup! docs(docs): 命名規則を追加する").length > 0)
    })
})

describe("scope と変更したファイル", () => {
    it("トップレベルのディレクトリを scope にする", () => {
        assert.equal(allowedScope(conventions, ["docs/naming.md", "docs/setup.md"]), "docs")
    })

    it("隠しディレクトリはドットを含める", () => {
        assert.equal(allowedScope(conventions, [".github/workflows/ci.yml"]), ".github")
    })

    it("apps と stacks と packages の下は、その下のディレクトリ名にする", () => {
        assert.equal(allowedScope(conventions, ["stacks/github/src/teams.ts"]), "github")
        assert.equal(allowedScope(conventions, ["packages/conventions/src/rules.ts"]), "conventions")
        assert.equal(allowedScope(conventions, ["apps/organizer-bot/src/index.ts"]), "organizer-bot")
    })

    it("複数のディレクトリやリポジトリ直下は repo にする", () => {
        assert.equal(allowedScope(conventions, ["docs/naming.md", "README.md"]), "repo")
        assert.equal(allowedScope(conventions, ["README.md"]), "repo")
        assert.equal(allowedScope(conventions, ["stacks/github/src/a.ts", "packages/conventions/src/b.ts"]), "repo")
    })

    it("変更したファイルと合わない scope を止める", () => {
        assert.ok(commit("docs(repo): 命名規則を追加する", ["docs/naming.md"]).length > 0)
        assert.deepEqual(commit("docs(docs): 命名規則を追加する", ["docs/naming.md"]), [])
    })
})

const issue_body = [
    "✳︎ Anthropic Claude Opus 5.5",
    "",
    "## 背景",
    "",
    "- 理由を書く。",
    "",
    "## 作業範囲",
    "",
    "- やること",
    "",
    "## 受け入れ条件",
    "",
    "- [ ] 条件",
    "",
    "## 備考",
    "",
    "- 補足",
].join("\n")

describe("Issue", () => {
    it("テンプレートどおりの本文を通す", () => {
        assert.deepEqual(checkIssue(conventions, "docs(docs): 命名規則を追加する", issue_body), [])
    })

    it("署名がないものを止める", () => {
        assert.ok(checkIssue(conventions, "docs(docs): 命名規則を追加する", issue_body.split("\n").slice(2).join("\n")).length > 0)
    })

    it("必須の欄が空のものを止める", () => {
        assert.ok(checkIssue(conventions, "docs(docs): 命名規則を追加する", issue_body.replace("- 理由を書く。", "")).length > 0)
    })

    it("受け入れ条件がタスクリストでないものを止める", () => {
        assert.ok(checkIssue(conventions, "docs(docs): 命名規則を追加する", issue_body.replace("- [ ] 条件", "- 条件")).length > 0)
    })

    it("欄の順番が違うものを止める", () => {
        const swapped = issue_body.replace("## 背景", "## 仮").replace("## 作業範囲", "## 背景").replace("## 仮", "## 作業範囲")
        assert.ok(checkIssue(conventions, "docs(docs): 命名規則を追加する", swapped).length > 0)
    })

    it("背景の最初の行が箇条書きでないものを止める", () => {
        const errors = checkIssue(conventions, "docs(docs): 命名規則を追加する", issue_body.replace("- 理由を書く。", "理由を書く。"))
        assert.ok(errors.includes("「背景」は最初の行から - の箇条書きで書く"))
    })

    it("背景は 2 行目以降が地の文でも、最初の行が箇条書きなら通す", () => {
        const body = issue_body.replace("- 理由を書く。", "- 理由を書く。\n\n補足の文。")
        assert.deepEqual(checkIssue(conventions, "docs(docs): 命名規則を追加する", body), [])
    })

    it("タイトルの形を止める", () => {
        assert.ok(checkIssue(conventions, "命名規則を追加する", issue_body).length > 0)
    })
})

const pull_request_body = issue_body.replace("## 備考", "## 影響範囲・残リスク\n\n- 影響範囲: なし\n\n## 備考")

describe("PR", () => {
    it("テンプレートどおりの本文を通す", () => {
        assert.deepEqual(checkPullRequest(conventions, "docs(docs): 命名規則を追加する", pull_request_body), [])
    })

    it("影響範囲・残リスクの欄がないものを止める", () => {
        assert.ok(checkPullRequest(conventions, "docs(docs): 命名規則を追加する", issue_body).length > 0)
    })

    it("Issue を自動で閉じるキーワードを止める", () => {
        assert.ok(checkPullRequest(conventions, "docs(docs): 命名規則を追加する", pull_request_body.replace("- 理由を書く。", "- Closes #2")).length > 0)
    })
})

describe("tag", () => {
    it("v を付けた semver を通す", () => {
        assert.deepEqual(checkTag(conventions, "v1.2.3"), [])
        assert.deepEqual(checkTag(conventions, "v1.2.3-rc.1"), [])
    })

    it("それ以外を止める", () => {
        assert.ok(checkTag(conventions, "1.2.3").length > 0)
        assert.ok(checkTag(conventions, "release-1").length > 0)
    })
})

describe("フッター", () => {
    const body = "✳︎ Anthropic Claude Opus 5.5\n\n## 背景\n\n理由を書く。"

    it("Claude Code の CLI のフッターを取り除く", () => {
        const result = stripFooters(conventions, `${body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`)
        assert.equal(result.body, body)
        assert.deepEqual(result.removed, ["Claude Code"])
    })

    it("Claude Code の Web のフッターを区切りの線ごと取り除く", () => {
        const result = stripFooters(conventions, `${body}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`)
        assert.equal(result.body, body)
    })

    it("Claude Code のセッションの URL の行を取り除く", () => {
        const result = stripFooters(conventions, `${body}\n\nhttps://claude.ai/code/session_01ABCdef`)
        assert.equal(result.body, body)
    })

    it("Cursor の印と画像リンクを取り除く", () => {
        const cursor = [
            "<!-- CURSOR_AGENT_PR_BODY_END -->",
            "",
            '<div><a href="https://cursor.com/agents/bc-1"><picture><img alt="Open in Web" src="https://cursor.com/assets/images/open-in-web-dark.png"></picture></a>&nbsp;<a href="https://cursor.com/background-agent?bcId=bc-1"><picture><img alt="Open in Cursor" src="x"></picture></a>&nbsp;</div>',
            "",
        ].join("\n")
        const result = stripFooters(conventions, `${body}\n${cursor}`)
        assert.equal(result.body, body)
        assert.deepEqual(result.removed, ["Cursor"])
    })

    it("Blacksmith のフッターの行を取り除く", () => {
        const result = stripFooters(conventions, `${body}\n\n<sub>Powered by [Blacksmith](https://blacksmith.sh)</sub>`)
        assert.equal(result.body, body)
    })

    it("フッターの形を説明する行は残す", () => {
        const text = [
            body,
            "",
            "- Cursor の `<!-- CURSOR_AGENT_PR_BODY_END -->` を消す",
            "- Blacksmith の「Powered by Blacksmith」の行を消す",
            "- セッションの URL は https://claude.ai/code/session_1 のような形",
            "- Claude Code の CLI の `🤖 Generated with [Claude Code](https://claude.com/claude-code)`",
        ].join("\n")
        const result = stripFooters(conventions, text)
        assert.deepEqual(result.removed, [])
        assert.equal(result.body, text)
    })

    it("本文の中でツールに触れた文は残す", () => {
        const text = `${body}\n\nClaude Code で生成したコードを Blacksmith のランナーで試した。\`claude.ai/code\` は使わない。`
        const result = stripFooters(conventions, text)
        assert.equal(result.body, text)
        assert.deepEqual(result.removed, [])
    })

    it("フッターのある Issue は違反にする", () => {
        const errors = checkIssue(conventions, "docs(docs): 命名規則を追加する", `${issue_body}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`)
        assert.ok(errors.includes("Claude Code のフッターを書かない"))
    })

    it("コミットメッセージのセッションの URL は止める", () => {
        assert.ok(commit("docs(docs): 命名規則を追加する\n\nClaude-Session: https://claude.ai/code/session_1").length > 0)
    })
})

describe("説明の判定の指示", () => {
    it("件名の説明の部分だけを渡し、type と scope を渡さない", () => {
        const prompt = semanticLintPrompt("feat(github): Environment を消す準備として protect を外せるようにする")
        assert.ok(prompt.includes("Description: Environment を消す準備として protect を外せるようにする"))
        assert.ok(!prompt.includes("feat(github)"))
    })

    it("type と scope を判定しないよう指示する", () => {
        assert.ok(semanticLintPrompt("docs(docs): 命名規則を追加する").includes("do not judge them"))
    })

    it("形の合わない件名は、そのまま渡す", () => {
        assert.ok(semanticLintPrompt("update").includes("Description: update"))
    })
})
