import assert from "node:assert/strict"
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto"
import { describe, it } from "node:test"
import { createAppJwt } from "./github.ts"
import { verifySignature } from "./webhook.ts"

describe("verifySignature", () => {
    const secret = "webhook-secret"
    const body = JSON.stringify({ action: "labeled" })
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

    it("正しい署名を通す", async () => {
        assert.equal(await verifySignature(secret, body, signature), true)
    })

    it("本文が書き換えられたものを止める", async () => {
        assert.equal(await verifySignature(secret, `${body} `, signature), false)
    })

    it("別の secret の署名を止める", async () => {
        const other = `sha256=${createHmac("sha256", "other").update(body).digest("hex")}`
        assert.equal(await verifySignature(secret, body, other), false)
    })

    it("署名のないものを止める", async () => {
        assert.equal(await verifySignature(secret, body, null), false)
    })
})

describe("createAppJwt", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

    it("App ID を発行者にした RS256 の JWT を作る", async () => {
        const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
        const now = Date.UTC(2026, 8, 30)
        const jwt = await createAppJwt("12345", pem, now)
        const [header, payload, signature] = jwt.split(".")
        assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" })
        const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { iss: string, iat: number, exp: number }
        assert.equal(claims.iss, "12345")
        assert.ok(claims.exp - claims.iat <= 600)
        assert.ok(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url")))
    })

    it("改行が \\n の文字になった鍵を読める", async () => {
        const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, "\\n")
        const jwt = await createAppJwt("12345", pem)
        assert.equal(jwt.split(".").length, 3)
    })

    it("1 行につながった鍵を読める", async () => {
        const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim().replace(/\n/g, " ")
        const jwt = await createAppJwt("12345", pem)
        assert.equal(jwt.split(".").length, 3)
    })

    it("PKCS#1 の鍵は変換を促して止める", async () => {
        const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()
        await assert.rejects(createAppJwt("12345", pem), /PKCS#8/)
    })
})
