import type { Conventions } from "@philtz/conventions/rules"
import { parse } from "yaml"
import { config } from "./config.ts"
import { expectOk, type GitHubRequest } from "./github.ts"

// 規約のファイルを持たないリポジトリでは、組織の正本を使う。正本の場所は config.conventions_repository

export const readConventions = async (request: GitHubRequest, full_name: string): Promise<Conventions> => {
    const raw = "application/vnd.github.raw+json"
    const own = await request("GET", `/repos/${full_name}/contents/.github/conventions.yml`, undefined, raw)
    if (own.status === 200 && typeof own.body === "string") {
        return parse(own.body) as Conventions
    }
    const fallback = await request("GET", `/repos/${config.conventions_repository}/contents/conventions.yml`, undefined, raw)
    return parse(expectOk(fallback, "org の規約のファイルを読む") as string) as Conventions
}
