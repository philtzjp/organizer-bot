import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { config, configure } from "./config.ts"

const original = { ...config }

const required = {
    ORGANIZATION: "another-org",
    BOT_LOGIN: "another-bot",
    BOT_USER_ID: "100000002",
    CONVENTIONS_REPOSITORY: "example-org/.github",
    CHECKER_REPOSITORY: "example-org/organizer-bot",
}

describe("configure", () => {
    afterEach(() => {
        Object.assign(config, original)
    })

    it("スキルとプロフィールのリポジトリは、空なら値がないものとして扱う", () => {
        configure({ ...required, SKILLS_REPOSITORY: "", PROFILE_REPOSITORY: "" })
        assert.equal(config.skills_repository, undefined)
        assert.equal(config.profile_repository, undefined)
    })

    it("スキルとプロフィールのリポジトリは、渡さなくても止めない", () => {
        configure(required)
        assert.equal(config.organization, "another-org")
        assert.equal(config.skills_repository, undefined)
    })

    it("必須の値がなければ止める", () => {
        assert.throws(() => configure({ ...required, ORGANIZATION: "" }), /ORGANIZATION/)
    })
})
