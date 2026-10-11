// GitHub の webhook の署名を確かめる。X-Hub-Signature-256 は、本文の HMAC-SHA256 を 16 進数にしたもの
export const verifySignature = async (secret: string, body: string, signature_header: string | null): Promise<boolean> => {
    if (signature_header === null || !signature_header.startsWith("sha256=")) {
        return false
    }
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    )
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
    const expected = `sha256=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
    if (expected.length !== signature_header.length) {
        return false
    }
    // 比べる時間から一致した長さを推測されないよう、途中で打ち切らずに最後まで比べる
    let difference = 0
    for (let index = 0; index < expected.length; index += 1) {
        difference |= expected.charCodeAt(index) ^ signature_header.charCodeAt(index)
    }
    return difference === 0
}
