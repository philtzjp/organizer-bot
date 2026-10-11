// org のプロフィールに出す統計の SVG を作る。
// 上の段にリポジトリの数とコミットを 1:2 の幅で並べ、下の段に言語を全幅で置いた 1 枚の画像にする。
// 広い画面用とスマートフォン用で文字の大きさと並べ方を変え、それぞれ明るい表示用と暗い表示用を作る。
// README では <picture> の media で、画面の幅と表示の設定に合う 1 枚を読む

export type Stats = {
    generated_at: string
    repositories: { public: number, private: number, archived: number }
    weekly_commits: { week_start: string, count: number }[]
    languages: { name: string, color: string | null, bytes: number }[]
}

type Theme = { text: string, muted: string, border: string, track: string, bar: string }

// 画面の幅ごとの寸法。文字の大きさは、その幅でそのまま表示したときに読める大きさにする
type Layout = {
    width: number
    gap: number
    padding: number
    top_height: number
    radius: number
    label: number
    big: number
    detail: number
    month: number
    // 月の名前を出す間隔。1 なら毎月、3 なら四半期ごと
    month_step: number
    legend: number
    legend_row: number
    legend_columns: number
    // 凡例に名前を出す言語の数。残りは Other にまとめる
    top_languages: number
    bar_gap: number
}

// 色は GitHub の画面の色に合わせる
const themes: Record<string, Theme> = {
    light: { text: "#1f2328", muted: "#59636e", border: "#d1d9e0", track: "#eff2f5", bar: "#1f2328" },
    dark: { text: "#f0f6fc", muted: "#9198a1", border: "#3d444d", track: "#262c36", bar: "#f0f6fc" },
}

const layouts: Record<string, Layout> = {
    wide: {
        width: 900, gap: 12, padding: 24, top_height: 232, radius: 12,
        label: 16, big: 60, detail: 18, month: 14, month_step: 1,
        legend: 13, legend_row: 26, legend_columns: 3, top_languages: 8, bar_gap: 3,
    },
    narrow: {
        width: 360, gap: 8, padding: 14, top_height: 172, radius: 10,
        label: 11, big: 36, detail: 12, month: 10, month_step: 3,
        legend: 10.5, legend_row: 18, legend_columns: 2, top_languages: 5, bar_gap: 1.5,
    },
}

const font = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif`
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const number = (value: number): string => value.toLocaleString("en-US")

const text = (x: number, y: number, content: string, size: number, color: string, weight = 400, anchor = "start"): string =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escape(content)}</text>`

const frame = (x: number, y: number, width: number, height: number, layout: Layout, theme: Theme): string =>
    `<rect x="${(x + 0.5).toFixed(1)}" y="${(y + 0.5).toFixed(1)}" width="${(width - 1).toFixed(1)}" height="${(height - 1).toFixed(1)}" rx="${layout.radius}" fill="none" stroke="${theme.border}"/>`

// ファイル名と SVG の中身の組を返す。ファイル名は stats-<wide か narrow>-<light か dark>.svg
export const renderStats = (stats: Stats): Record<string, string> => {
    const active = stats.repositories.public + stats.repositories.private
    const total_commits = stats.weekly_commits.reduce((sum, week) => sum + week.count, 0)

    const renderRepositories = (x: number, width: number, layout: Layout, theme: Theme): string[] => {
        const { padding: p, label, big, detail } = layout
        const left = x + p
        const line = detail * 1.55
        const bottom = layout.top_height - p
        return [
            frame(x, 0, width, layout.top_height, layout, theme),
            text(left, p + label, "Repositories", label, theme.muted, 600),
            text(left, p + label + big * 1.1, number(active), big, theme.text, 600),
            text(left, bottom - line * 2, `${number(stats.repositories.private)} private`, detail, theme.text),
            text(left, bottom - line, `${number(stats.repositories.public)} public`, detail, theme.text),
            text(left, bottom, `${number(stats.repositories.archived)} archived`, detail, theme.muted),
        ]
    }

    const renderCommits = (x: number, width: number, layout: Layout, theme: Theme): string[] => {
        const { padding: p, label, month } = layout
        const x0 = x + p
        const x1 = x + width - p
        const parts = [
            frame(x, 0, width, layout.top_height, layout, theme),
            text(x0, p + label, "Commits in the last 52 weeks", label, theme.muted, 600),
            text(x1, p + label, number(total_commits), label, theme.text, 600, "end"),
        ]
        const chart_top = p + label * 2.2
        const chart_height = layout.top_height - chart_top - p - month * 1.8
        const max = Math.max(1, ...stats.weekly_commits.map((week) => week.count))
        const slot = (x1 - x0) / stats.weekly_commits.length
        const bar_width = Math.max(1.5, slot - layout.bar_gap)
        stats.weekly_commits.forEach((week, index) => {
            const bar_x = x0 + index * slot
            const bar_height = week.count === 0 ? 0 : Math.max(1.5, (week.count / max) * chart_height)
            parts.push(`<rect x="${bar_x.toFixed(2)}" y="${chart_top.toFixed(2)}" width="${bar_width.toFixed(2)}" height="${chart_height.toFixed(2)}" rx="1" fill="${theme.track}"/>`)
            if (bar_height > 0) {
                parts.push(`<rect x="${bar_x.toFixed(2)}" y="${(chart_top + chart_height - bar_height).toFixed(2)}" width="${bar_width.toFixed(2)}" height="${bar_height.toFixed(2)}" rx="1" fill="${theme.bar}"/>`)
            }
            // 月が変わる週の下に月の名前を出す。右端ではみ出すものは出さない
            const start = new Date(`${week.week_start}T00:00:00Z`)
            const previous = index === 0 ? null : new Date(`${stats.weekly_commits[index - 1]!.week_start}T00:00:00Z`)
            const center = bar_x + bar_width / 2
            if (previous !== null && start.getUTCMonth() !== previous.getUTCMonth() && start.getUTCMonth() % layout.month_step === 0 && center + month <= x1) {
                parts.push(text(center, chart_top + chart_height + month * 1.5, months[start.getUTCMonth()]!, month, theme.muted, 400, "middle"))
            }
        })
        return parts
    }

    // 凡例に出す言語。上位のものと、残りをまとめた Other にする
    const languageRows = (layout: Layout): { name: string, color: string, ratio: number }[] => {
        const total = stats.languages.reduce((sum, language) => sum + language.bytes, 0)
        const top = stats.languages.slice(0, layout.top_languages).map((language) => ({ name: language.name, color: language.color ?? "#8b949e", ratio: language.bytes / total }))
        const rest = 1 - top.reduce((sum, language) => sum + language.ratio, 0)
        return rest > 0.001 ? [...top, { name: "Other", color: "#8b949e", ratio: rest }] : top
    }

    // 下の段を y から描き、凡例の高さを含めた高さを返す
    const renderLanguages = (y: number, layout: Layout, theme: Theme): { parts: string[], height: number } => {
        const { padding: p, label, legend, legend_row, legend_columns, width } = layout
        const languages = languageRows(layout)
        const rows = Math.ceil(languages.length / legend_columns)
        const bar_top = y + p + label * 1.8
        const bar_height = Math.round(label * 0.7)
        const legend_top = bar_top + bar_height + legend_row
        const height = legend_top - y + (rows - 1) * legend_row + p
        const bar_length = width - p * 2
        const parts = [
            frame(0, y, width, height, layout, theme),
            text(p, y + p + label, "Languages", label, theme.muted, 600),
            `<clipPath id="language-bar"><rect x="${p}" y="${bar_top.toFixed(1)}" width="${bar_length}" height="${bar_height}" rx="${bar_height / 2}"/></clipPath>`,
        ]
        let offset = p
        const segments = languages.map((language) => {
            const length = language.ratio * bar_length
            const segment = `<rect x="${offset.toFixed(2)}" y="${bar_top.toFixed(1)}" width="${length.toFixed(2)}" height="${bar_height}" fill="${language.color}"/>`
            offset += length
            return segment
        })
        parts.push(`<g clip-path="url(#language-bar)">${segments.join("")}</g>`)
        // 凡例は列ごとに上から並べ、割合を列の右に揃える
        const column_width = bar_length / legend_columns
        const column_gap = legend * 2
        languages.forEach((language, index) => {
            const column = Math.floor(index / rows)
            const row = index % rows
            const x = p + column * column_width
            const legend_y = legend_top + row * legend_row
            const right = x + column_width - (column === legend_columns - 1 ? 0 : column_gap)
            const radius = legend * 0.36
            parts.push(`<circle cx="${(x + radius).toFixed(1)}" cy="${(legend_y - legend * 0.36).toFixed(1)}" r="${radius.toFixed(1)}" fill="${language.color}"/>`)
            parts.push(text(x + radius * 2 + legend * 0.5, legend_y, language.name, legend, theme.text, 600))
            parts.push(text(right, legend_y, `${(language.ratio * 100).toFixed(1)}%`, legend, theme.muted, 400, "end"))
        })
        return { parts, height }
    }

    const render = (layout: Layout, theme: Theme): string => {
        // 上の段の 2 枚は、間の gap を除いた幅を 1:2 に分ける
        const unit = (layout.width - layout.gap) / 3
        const languages = renderLanguages(layout.top_height + layout.gap, layout, theme)
        const height = Math.ceil(layout.top_height + layout.gap + languages.height)
        const summary = [
            `${number(active)} repositories`,
            `${number(total_commits)} commits in the last 52 weeks`,
            `languages: ${languageRows(layout).map((language) => `${language.name} ${(language.ratio * 100).toFixed(1)}%`).join(", ")}`,
        ].join("; ")
        return [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${height}" viewBox="0 0 ${layout.width} ${height}" font-family='${font}'>`,
            `<title>Philtz on GitHub: ${escape(summary)}</title>`,
            ...renderRepositories(0, unit, layout, theme),
            ...renderCommits(unit + layout.gap, unit * 2, layout, theme),
            ...languages.parts,
            "</svg>",
            "",
        ].join("\n")
    }

    const files: Record<string, string> = {}
    for (const [layout_name, layout] of Object.entries(layouts)) {
        for (const [theme_name, theme] of Object.entries(themes)) {
            files[`stats-${layout_name}-${theme_name}.svg`] = render(layout, theme)
        }
    }
    return files
}
