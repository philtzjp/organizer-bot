// src/cli.ts を、依存のない 1 ファイルの skill/cli.mjs にまとめる。
// philtz-organizer-bot が skill/ を philtzjp/skills の conventions スキルに写し、各リポジトリの hook がそれを呼ぶ
import { build } from "esbuild"

await build({
    entryPoints: ["src/cli.ts"],
    outfile: "skill/cli.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
    // まとめた依存の中の require を、ESM でも動くようにする
    banner: {
        js: [
            "// philtzjp/organizer-bot の packages/conventions を pnpm run build でまとめたもの。直接編集しない",
            "import { createRequire } from \"node:module\"",
            "const require = createRequire(import.meta.url)",
        ].join("\n"),
    },
})
