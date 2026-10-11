// GitHub App の bot として GitHub の API を呼ぶ
import { config } from "./config.ts"

export type GitHubResponse = {
    status: number
    body: unknown
}

// method と path で GitHub の API を呼ぶ関数。テストでは差し替える
export type GitHubRequest = (method: string, path: string, body?: unknown, accept?: string) => Promise<GitHubResponse>

// ボットが書くコメントの先頭の署名。人とエージェントの署名と同じく、次の行は空ける
export const botSignature = (): string => `✳︎ ${config.bot_login}`

// squash のコミットの committer。GitHub は <ユーザー ID>+<login>@users.noreply.github.com のアドレスで bot に紐づける
export const botCommitter = (): { name: string, email: string } => ({
    name: `${config.bot_login}[bot]`,
    email: `${config.bot_user_id}+${config.bot_login}[bot]@users.noreply.github.com`,
})

const api_url = "https://api.github.com"
const api_version = "2026-03-10"

const encodeBase64Url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

const encodeJson = (value: unknown): string => encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)))

// Web Crypto は PKCS#8 の鍵しか読めない。GitHub が発行する鍵は PKCS#1 なので、secret に入れる前に変換しておく
const importPrivateKey = async (value: string): Promise<CryptoKey> => {
    // secret に貼ったときに改行が \\n の文字になっていたら改行に戻す
    const pem = value.replace(/\\n/g, "\n").trim()
    if (pem.includes("BEGIN RSA PRIVATE KEY")) {
        throw new Error("秘密鍵が PKCS#1 の形です。docs/setup.md の手順で PKCS#8 に変換してから secret に入れてください")
    }
    const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")
    const der = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
    return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
}

export const createAppJwt = async (app_id: string, private_key_pem: string, now = Date.now()): Promise<string> => {
    const seconds = Math.floor(now / 1000)
    // 時計のずれを見込んで 60 秒前から有効にし、上限の 10 分より短い 9 分で切る
    const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iat: seconds - 60, exp: seconds + 540, iss: app_id })}`
    const key = await importPrivateKey(private_key_pem)
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned))
    return `${unsigned}.${encodeBase64Url(new Uint8Array(signature))}`
}

const headers = (token: string, accept = "application/vnd.github+json"): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": api_version,
    // GitHub の API は User-Agent のない要求を断る
    "user-agent": config.bot_login,
})

export const createInstallationRequest = async (
    app_id: string,
    private_key_pem: string,
    installation_id: number,
): Promise<GitHubRequest> => {
    const jwt = await createAppJwt(app_id, private_key_pem)
    const response = await fetch(`${api_url}/app/installations/${installation_id}/access_tokens`, {
        method: "POST",
        headers: headers(jwt),
    })
    if (!response.ok) {
        throw new Error(`installation token を作れませんでした: ${response.status} ${await response.text()}`)
    }
    const { token } = await response.json() as { token: string }
    return async (method, path, body, accept) => {
        const result = await fetch(`${api_url}${path}`, {
            method,
            headers: { ...headers(token, accept), ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const text = await result.text()
        let parsed: unknown = text
        try {
            parsed = text === "" ? undefined : JSON.parse(text)
        } catch {
            // raw の応答は文字列のまま返す
        }
        return { status: result.status, body: parsed }
    }
}

// webhook の外から呼ぶときに、org への installation を探してから呼び出しの関数を作る
export const createOrganizationRequest = async (app_id: string, private_key_pem: string, organization: string): Promise<GitHubRequest> => {
    const jwt = await createAppJwt(app_id, private_key_pem)
    const response = await fetch(`${api_url}/orgs/${organization}/installation`, { headers: headers(jwt) })
    if (!response.ok) {
        throw new Error(`${organization} の installation を読めませんでした: ${response.status} ${await response.text()}`)
    }
    const { id } = await response.json() as { id: number }
    return createInstallationRequest(app_id, private_key_pem, id)
}

// 2xx でなければ例外にする
export const expectOk = (response: GitHubResponse, action: string): unknown => {
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`${action}: ${response.status} ${JSON.stringify(response.body)}`)
    }
    return response.body
}

// ページを順に読んで、配列をつなげる。100 件ずつ、30 ページまで読む
export const readAll = async <T>(request: GitHubRequest, path: string, pick: (body: unknown) => T[]): Promise<T[]> => {
    const items: T[] = []
    for (let page = 1; page <= 30; page += 1) {
        const separator = path.includes("?") ? "&" : "?"
        const batch = pick(expectOk(await request("GET", `${path}${separator}per_page=100&page=${page}`), `${path} を読む`))
        items.push(...batch)
        if (batch.length < 100) {
            break
        }
    }
    return items
}
