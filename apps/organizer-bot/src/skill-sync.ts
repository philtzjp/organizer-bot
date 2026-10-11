// 書式の検査器と組織の規約の正本を、conventions スキルに写す。
// 各リポジトリは、スキルとして入れた検査器を git hook から呼ぶ。版は固定せず、常に写す元の main と同じにする
import { config, splitRepository } from "./config.ts"
import { expectOk, type GitHubRequest } from "./github.ts"
import { publishFiles, type PublishResult } from "./stats-publish.ts"

// スキルのファイル名と、写す元。検査器は config.checker_repository に、規約は config.conventions_repository にある
export const conventionsSkillFiles = (): Record<string, { repository: string, path: string }> => ({
    "SKILL.md": { repository: config.checker_repository, path: "packages/conventions/skill/SKILL.md" },
    "cli.mjs": { repository: config.checker_repository, path: "packages/conventions/skill/cli.mjs" },
    "conventions.yml": { repository: config.conventions_repository, path: "conventions.yml" },
})

export const conventions_skill_message = "chore(.agents): conventions スキルを組織の規約と検査器に合わせる"

export const syncConventionsSkill = async (request: GitHubRequest): Promise<PublishResult> => {
    const files: Record<string, string> = {}
    for (const [name, source] of Object.entries(conventionsSkillFiles())) {
        const response = await request("GET", `/repos/${source.repository}/contents/${source.path}?ref=main`, undefined, "application/vnd.github.raw+json")
        const content = expectOk(response, `${source.repository} の ${source.path} を読む`)
        if (typeof content !== "string") {
            throw new Error(`${source.repository} の ${source.path} を文字列として読めなかった`)
        }
        files[name] = content
    }
    return publishFiles(request, {
        ...splitRepository(config.skills_repository),
        branch: "main",
        directory: ".agents/skills/conventions",
        message: conventions_skill_message,
    }, files)
}

// 検査器か規約の PR をマージしたら写す。中身が変わっていなければ publishFiles がコミットしない
export const isConventionsSource = (owner: string, repository: string): boolean =>
    [config.checker_repository, config.conventions_repository].includes(`${owner}/${repository}`)
