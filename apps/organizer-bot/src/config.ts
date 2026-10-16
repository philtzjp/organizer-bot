// 組織に固有の値。コードには書かず、Worker の環境変数で受け取る。
// テストでは configure を呼ばず、下の架空の値をそのまま使う

export type ConfigEnv = {
    // bot を入れた組織の login
    ORGANIZATION: string
    // GitHub App の slug。bot のユーザーの login は <slug>[bot] になる
    BOT_LOGIN: string
    // bot のユーザーの ID。コミットのメールアドレスを bot に紐づけるのに使う
    BOT_USER_ID: string
    // 規約のファイルを持たないリポジトリが従う、組織の規約の正本のリポジトリ。<owner>/<repo> の形
    CONVENTIONS_REPOSITORY: string
    // 書式の検査器のコードがあるリポジトリ。<owner>/<repo> の形
    CHECKER_REPOSITORY: string
    // 検査器を conventions スキルとして配るリポジトリ。<owner>/<repo> の形。空なら写さない
    SKILLS_REPOSITORY?: string
    // 組織のプロフィールの統計の画像を置くリポジトリ。<owner>/<repo> の形。空なら作らない
    PROFILE_REPOSITORY?: string
    // 統計から外すリポジトリの名前。カンマで区切る
    STATS_EXCLUDED_REPOSITORIES?: string
}

export type Config = {
    organization: string
    bot_login: string
    bot_user_id: string
    conventions_repository: string
    checker_repository: string
    skills_repository: string | undefined
    profile_repository: string | undefined
    stats_excluded_repositories: Set<string>
}

export const config: Config = {
    organization: "example-org",
    bot_login: "example-bot",
    bot_user_id: "100000001",
    conventions_repository: "example-org/.github",
    checker_repository: "example-org/organizer-bot",
    skills_repository: "example-org/skills",
    profile_repository: "example-org/.github",
    stats_excluded_repositories: new Set(["excluded-repository"]),
}

// 任意の値。wrangler deploy の --var は空の値も渡すので、空は値がないものとして扱う
const optionalValue = (value: string | undefined): string | undefined => (value ?? "") === "" ? undefined : value

// 必要な値がなければ、間違った組織を書き換えないよう止める
export const configure = (env: ConfigEnv): void => {
    const required = ["ORGANIZATION", "BOT_LOGIN", "BOT_USER_ID", "CONVENTIONS_REPOSITORY", "CHECKER_REPOSITORY"] as const
    const missing = required.filter((name) => (env[name] ?? "") === "")
    if (missing.length > 0) {
        throw new Error(`Worker の環境変数がない: ${missing.join(", ")}`)
    }
    Object.assign(config, {
        organization: env.ORGANIZATION,
        bot_login: env.BOT_LOGIN,
        bot_user_id: env.BOT_USER_ID,
        conventions_repository: env.CONVENTIONS_REPOSITORY,
        checker_repository: env.CHECKER_REPOSITORY,
        skills_repository: optionalValue(env.SKILLS_REPOSITORY),
        profile_repository: optionalValue(env.PROFILE_REPOSITORY),
        stats_excluded_repositories: new Set((env.STATS_EXCLUDED_REPOSITORIES ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "")),
    })
}

// <owner>/<repo> を分ける
export const splitRepository = (full_name: string): { owner: string, repository: string } => {
    const [owner, repository] = full_name.split("/")
    if (owner === undefined || repository === undefined || owner === "" || repository === "") {
        throw new Error(`${full_name} は <owner>/<repo> の形でない`)
    }
    return { owner, repository }
}
