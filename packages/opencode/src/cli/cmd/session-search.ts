import type { Argv } from "yargs"
import { Database as BunDatabase } from "bun:sqlite"
import { readdirSync } from "fs"
import path from "path"
import { EOL } from "os"
import { Global } from "@opencode-ai/core/global"
import { cmd } from "./cmd"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Process } from "@/util/process"
import { which } from "../../util/which"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { errorMessage } from "../../util/error"

interface SessionRow {
  id: string
  title: string
  directory: string
  path: string | null
  time_created: number
  time_updated: number
  model: string | null
  agent: string | null
  summary_files: number | null
  summary_additions: number | null
  summary_deletions: number | null
}

interface SearchResult {
  db: string
  session: SessionRow
  snippet?: string
}

function dbLabel(filePath: string): string {
  const name = path.basename(filePath).replace("opencode", "").replace(".db", "")
  if (name === "") return "stable"
  return name.replace(/^-/, "")
}

function discoverDbs(filter?: string): { path: string; label: string }[] {
  const dir = Global.Path.data
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith("opencode") && e.name.endsWith(".db"))
    .map((e) => {
      const p = path.join(dir, e.name)
      return { path: p, label: dbLabel(p) }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  if (filter) return entries.filter((e) => e.label.includes(filter.toLowerCase()))
  return entries
}

function openReadonly(dbPath: string): BunDatabase | undefined {
  try {
    return new BunDatabase(dbPath, { readonly: true })
  } catch {
    return undefined
  }
}

function hasColumn(db: BunDatabase, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  return rows.some((r) => r.name === column)
}

function searchByTitle(dbs: { path: string; label: string }[], opts: SearchOpts): SearchResult[] {
  const results: SearchResult[] = []

  for (const entry of dbs) {
    const db = openReadonly(entry.path)
    if (!db) continue
    try {
      const hasPath = hasColumn(db, "session", "path")
      const hasModel = hasColumn(db, "session", "model")
      const hasAgent = hasColumn(db, "session", "agent")
      const pathCol = hasPath ? "s.path" : "NULL"
      const modelCol = hasModel ? "s.model" : "NULL"
      const agentCol = hasAgent ? "s.agent" : "NULL"

      let sql = `
        SELECT s.id, s.title, s.directory, ${pathCol} as path, s.time_created, s.time_updated,
               ${modelCol} as model, ${agentCol} as agent,
               s.summary_files, s.summary_additions, s.summary_deletions
        FROM session s WHERE 1=1
      `
      const params: (string | number)[] = []

      if (opts.query) {
        sql += " AND s.title LIKE ?"
        params.push(`%${opts.query}%`)
      }
      if (opts.dir) {
        sql += " AND s.directory LIKE ?"
        params.push(`%${opts.dir}%`)
      }
      if (opts.since) {
        sql += " AND s.time_created >= ?"
        params.push(opts.since)
      }
      if (opts.until) {
        sql += " AND s.time_created <= ?"
        params.push(opts.until)
      }

      sql += " ORDER BY s.time_created DESC"

      for (const row of db.query<SessionRow, (string | number)[]>(sql).all(...params)) {
        results.push({ db: entry.label, session: row })
      }
    } finally {
      db.close()
    }
  }

  results.sort((a, b) => b.session.time_created - a.session.time_created)
  return results.slice(0, opts.limit)
}

function searchByContent(dbs: { path: string; label: string }[], opts: SearchOpts): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()

  for (const entry of dbs) {
    const db = openReadonly(entry.path)
    if (!db) continue
    try {
      const hasPath = hasColumn(db, "session", "path")
      const hasModel = hasColumn(db, "session", "model")
      const hasAgent = hasColumn(db, "session", "agent")
      const pathCol = hasPath ? "s.path" : "NULL"
      const modelCol = hasModel ? "s.model" : "NULL"
      const agentCol = hasAgent ? "s.agent" : "NULL"

      let sql = `
        SELECT DISTINCT s.id, s.title, s.directory, ${pathCol} as path, s.time_created, s.time_updated,
               ${modelCol} as model, ${agentCol} as agent,
               s.summary_files, s.summary_additions, s.summary_deletions,
               p.data as match_data
        FROM session s
        JOIN message m ON m.session_id = s.id
        JOIN part p ON p.message_id = m.id
        WHERE json_extract(p.data, '$.type') = 'text'
          AND p.data LIKE ?
      `
      const params: (string | number)[] = [`%${opts.query}%`]

      if (opts.dir) {
        sql += " AND s.directory LIKE ?"
        params.push(`%${opts.dir}%`)
      }
      if (opts.since) {
        sql += " AND s.time_created >= ?"
        params.push(opts.since)
      }
      if (opts.until) {
        sql += " AND s.time_created <= ?"
        params.push(opts.until)
      }

      sql += " ORDER BY s.time_created DESC"

      for (const row of db
        .query<SessionRow & { match_data: string }, (string | number)[]>(sql)
        .all(...params)) {
        if (seen.has(row.id)) continue
        seen.add(row.id)

        let snippet: string | undefined
        try {
          const text: string = JSON.parse(row.match_data).text ?? ""
          const idx = text.toLowerCase().indexOf(opts.query!.toLowerCase())
          if (idx >= 0) {
            const start = Math.max(0, idx - 60)
            const end = Math.min(text.length, idx + opts.query!.length + 60)
            snippet = (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "")
          }
        } catch {}

        results.push({ db: entry.label, session: row, snippet })
      }
    } finally {
      db.close()
    }
  }

  results.sort((a, b) => b.session.time_created - a.session.time_created)
  return results.slice(0, opts.limit)
}

function showDetail(dbs: { path: string; label: string }[], sessionId: string) {
  for (const entry of dbs) {
    const db = openReadonly(entry.path)
    if (!db) continue
    try {
      const row = db.query<SessionRow, [string]>("SELECT * FROM session WHERE id = ?").get(sessionId)
      if (!row) continue

      UI.println(
        EOL +
          UI.Style.TEXT_HIGHLIGHT_BOLD +
          "Session: " +
          row.title +
          UI.Style.TEXT_NORMAL,
      )
      UI.println("  " + UI.Style.TEXT_DIM + "ID:        " + UI.Style.TEXT_NORMAL + row.id)
      UI.println("  " + UI.Style.TEXT_DIM + "DB:        " + UI.Style.TEXT_NORMAL + entry.label)
      UI.println("  " + UI.Style.TEXT_DIM + "Directory: " + UI.Style.TEXT_NORMAL + row.directory)
      if (row.path) UI.println("  " + UI.Style.TEXT_DIM + "Path:      " + UI.Style.TEXT_NORMAL + row.path)
      UI.println("  " + UI.Style.TEXT_DIM + "Created:   " + UI.Style.TEXT_NORMAL + Locale.datetime(row.time_created))
      UI.println("  " + UI.Style.TEXT_DIM + "Updated:   " + UI.Style.TEXT_NORMAL + Locale.datetime(row.time_updated))

      if (row.model) {
        try {
          const m = JSON.parse(row.model) as { id?: string; providerID?: string }
          UI.println(
            "  " + UI.Style.TEXT_DIM + "Model:     " + UI.Style.TEXT_NORMAL + `${m.id ?? "?"} (${m.providerID ?? "?"})`,
          )
        } catch {}
      }
      if (row.agent) UI.println("  " + UI.Style.TEXT_DIM + "Agent:     " + UI.Style.TEXT_NORMAL + row.agent)

      const stats: string[] = []
      if (row.summary_files) stats.push(`${row.summary_files} files`)
      if (row.summary_additions) stats.push(`+${row.summary_additions}`)
      if (row.summary_deletions) stats.push(`-${row.summary_deletions}`)
      if (stats.length) UI.println("  " + UI.Style.TEXT_DIM + "Changes:   " + UI.Style.TEXT_NORMAL + stats.join(", "))

      // Messages
      const messages = db
        .query<{ id: string; time_created: number; data: string }, [string]>(
          "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
        )
        .all(sessionId)

      UI.println(EOL + "  " + UI.Style.TEXT_NORMAL_BOLD + `Messages (${messages.length}):` + UI.Style.TEXT_NORMAL)

      for (const msg of messages) {
        let role = "?"
        try {
          role = (JSON.parse(msg.data) as { role?: string }).role ?? "?"
        } catch {}

        const parts = db
          .query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ? ORDER BY id", )
          .all(msg.id)

        const texts: string[] = []
        let toolCount = 0
        for (const p of parts) {
          try {
            const pd = JSON.parse(p.data) as { type?: string; text?: string }
            if (pd.type === "text" && pd.text) texts.push(pd.text)
            else if (pd.type === "tool") toolCount++
          } catch {}
        }

        const roleColor =
          role === "user"
            ? UI.Style.TEXT_SUCCESS
            : role === "assistant"
              ? UI.Style.TEXT_INFO
              : UI.Style.TEXT_WARNING
        const content = texts.join(" ").slice(0, 200) + (texts.join(" ").length > 200 ? "..." : "")
        const toolSuffix = toolCount ? ` ${UI.Style.TEXT_DIM}[+${toolCount} tools]${UI.Style.TEXT_NORMAL}` : ""
        const timeStr = Locale.time(msg.time_created)

        if (content.trim()) {
          UI.println(
            `    ${roleColor}${role.padStart(9)}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}${timeStr}${UI.Style.TEXT_NORMAL}${toolSuffix}`,
          )
          for (const line of content.split("\n").slice(0, 3)) {
            if (line.trim()) UI.println(`             ${line.trim()}`)
          }
        }
      }

      return
    } finally {
      db.close()
    }
  }

  UI.error(`Session ${sessionId} not found in any database.`)
}

function shortenDir(dir: string): string {
  const home = Global.Path.home
  if (dir.startsWith(home)) return "~" + dir.slice(home.length)
  return dir.length > 45 ? "..." + dir.slice(-42) : dir
}

function formatTable(results: SearchResult[]): string {
  if (results.length === 0) return UI.Style.TEXT_DIM + "No sessions found." + UI.Style.TEXT_NORMAL

  const lines: string[] = [
    "",
    UI.Style.TEXT_NORMAL_BOLD + `${results.length} session(s) found:` + UI.Style.TEXT_NORMAL,
    "",
  ]

  let lastDate = ""
  for (const r of results) {
    const date = new Date(r.session.time_created).toLocaleDateString()
    if (date !== lastDate) {
      lines.push("  " + UI.Style.TEXT_INFO_BOLD + date + UI.Style.TEXT_NORMAL)
      lastDate = date
    }

    const timeStr = Locale.time(r.session.time_created)
    const title = Locale.truncate(r.session.title, 70)
    const dir = shortenDir(r.session.directory)

    const stats: string[] = []
    if (r.session.summary_files) stats.push(`${r.session.summary_files}f`)
    if (r.session.summary_additions) stats.push(`+${r.session.summary_additions}`)
    if (r.session.summary_deletions) stats.push(`-${r.session.summary_deletions}`)
    const statStr = stats.length ? ` ${UI.Style.TEXT_DIM}[${stats.join(" ")}]${UI.Style.TEXT_NORMAL}` : ""
    const dbTag = r.db !== "stable" ? ` ${UI.Style.TEXT_DIM}(${r.db})${UI.Style.TEXT_NORMAL}` : ""

    lines.push(
      `    ${UI.Style.TEXT_DIM}${timeStr}${UI.Style.TEXT_NORMAL}  ${UI.Style.TEXT_HIGHLIGHT}${title}${UI.Style.TEXT_NORMAL}${dbTag}${statStr}`,
    )
    lines.push(`          ${UI.Style.TEXT_DIM}${dir}  ${r.session.id}${UI.Style.TEXT_NORMAL}`)

    if (r.snippet) {
      lines.push(`          ${UI.Style.TEXT_WARNING}» ${r.snippet.replaceAll("\n", " ")}${UI.Style.TEXT_NORMAL}`)
    }
  }

  lines.push("")
  return lines.join(EOL)
}

function formatJson(results: SearchResult[]): string {
  return JSON.stringify(
    results.map((r) => ({
      id: r.session.id,
      title: r.session.title,
      directory: r.session.directory,
      created: r.session.time_created,
      updated: r.session.time_updated,
      db: r.db,
      ...(r.snippet ? { snippet: r.snippet } : {}),
    })),
    null,
    2,
  )
}

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") return ["less", ...lessOptions]
  const lessOnPath = which("less")
  if (lessOnPath && Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }
  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }
  return ["cmd", "/c", "more"]
}

function parseDate(s: string): number {
  // Relative: "7d", "2w"
  const relMatch = /^(\d+)([dw])$/.exec(s)
  if (relMatch) {
    const n = Number(relMatch[1])
    const ms = relMatch[2] === "w" ? n * 7 * 86400000 : n * 86400000
    return Date.now() - ms
  }
  const ts = new Date(s).getTime()
  if (isNaN(ts)) throw new Error(`Cannot parse date: ${s}`)
  return ts
}

interface SearchOpts {
  query?: string
  dir?: string
  since?: number
  until?: number
  limit: number
}

function listDbs(dbs: { path: string; label: string }[]): string {
  const lines: string[] = [
    "",
    UI.Style.TEXT_NORMAL_BOLD + "Databases:" + UI.Style.TEXT_NORMAL,
    "",
  ]

  for (const entry of dbs) {
    const db = openReadonly(entry.path)
    if (!db) {
      lines.push(`  ${UI.Style.TEXT_HIGHLIGHT}${entry.label.padEnd(40)}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}(error opening)${UI.Style.TEXT_NORMAL}`)
      continue
    }
    try {
      const count = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM session").get()!.c
      const latest = db.query<{ t: number | null }, []>("SELECT MAX(time_created) as t FROM session").get()!.t
      const latestStr = latest ? Locale.datetime(latest) : "n/a"
      lines.push(
        `  ${UI.Style.TEXT_HIGHLIGHT}${entry.label.padEnd(40)}${UI.Style.TEXT_NORMAL} ${String(count).padStart(5)} sessions  ${UI.Style.TEXT_DIM}latest: ${latestStr}${UI.Style.TEXT_NORMAL}`,
      )
    } finally {
      db.close()
    }
  }

  lines.push("")
  return lines.join(EOL)
}

function listDirs(dbs: { path: string; label: string }[], limit: number): string {
  const counts = new Map<string, number>()

  for (const entry of dbs) {
    const db = openReadonly(entry.path)
    if (!db) continue
    try {
      for (const row of db
        .query<{ directory: string; cnt: number }, []>(
          "SELECT directory, COUNT(*) as cnt FROM session GROUP BY directory",
        )
        .all()) {
        counts.set(row.directory, (counts.get(row.directory) ?? 0) + row.cnt)
      }
    } finally {
      db.close()
    }
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  const lines: string[] = [
    "",
    UI.Style.TEXT_NORMAL_BOLD + "Directories with sessions:" + UI.Style.TEXT_NORMAL,
    "",
  ]

  for (const [dir, count] of sorted) {
    lines.push(`  ${String(count).padStart(5)}  ${UI.Style.TEXT_HIGHLIGHT}${shortenDir(dir)}${UI.Style.TEXT_NORMAL}`)
  }

  lines.push("")
  return lines.join(EOL)
}

export const SessionSearchCommand = cmd({
  command: "search [query]",
  describe: "search sessions across all databases",
  builder: (yargs: Argv) =>
    yargs
      .positional("query", {
        type: "string",
        describe: "search titles (or message content with -m)",
      })
      .option("messages", {
        alias: "m",
        type: "boolean",
        describe: "search message content (slower)",
        default: false,
      })
      .option("dir", {
        alias: "d",
        type: "string",
        describe: "filter by directory path",
      })
      .option("since", {
        type: "string",
        describe: "sessions after date (YYYY-MM-DD or Nd/Nw)",
      })
      .option("until", {
        type: "string",
        describe: "sessions before date",
      })
      .option("db", {
        type: "string",
        describe: "search only a specific DB (e.g. dev, stable)",
      })
      .option("id", {
        type: "string",
        describe: "show details for a specific session ID",
      })
      .option("all", {
        type: "boolean",
        describe: "list all sessions (no date filter)",
        default: false,
      })
      .option("dbs", {
        type: "boolean",
        describe: "list available databases",
        default: false,
      })
      .option("dirs", {
        type: "boolean",
        describe: "list directories with session counts",
        default: false,
      })
      .option("format", {
        type: "string",
        choices: ["table", "json"],
        default: "table",
        describe: "output format",
      })
      .option("max-count", {
        alias: "n",
        type: "number",
        describe: "max results (default: 50)",
        default: 50,
      }),
  handler: async (args) => {
    try {
      const dbs = discoverDbs(args.db as string | undefined)
      if (dbs.length === 0) {
        UI.error("No opencode databases found.")
        process.exit(1)
      }

      let output: string

      if (args.dbs) {
        output = listDbs(dbs)
      } else if (args.dirs) {
        output = listDirs(dbs, args.maxCount ?? 50)
      } else if (args.id) {
        showDetail(dbs, args.id as string)
        return
      } else {
        const since = args.since ? parseDate(args.since as string) : undefined
        const until = args.until ? parseDate(args.until as string) : undefined
        const query = args.query as string | undefined

        // Default: last 7 days if no query and no --all
        const effectiveSince =
          !query && !args.all && !since && !until && !args.dir ? Date.now() - 7 * 86400000 : since

        const opts: SearchOpts = {
          query,
          dir: args.dir as string | undefined,
          since: effectiveSince,
          until,
          limit: args.maxCount ?? 50,
        }

        const results =
          args.messages && query ? searchByContent(dbs, opts) : searchByTitle(dbs, opts)

        output = args.format === "json" ? formatJson(results) : formatTable(results)
      }

      const shouldPaginate = process.stdout.isTTY && args.format !== "json"
      if (shouldPaginate && output.split("\n").length > (process.stdout.rows ?? 40)) {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })
        if (proc.stdin) {
          proc.stdin.write(output)
          proc.stdin.end()
          await proc.exited
        } else {
          console.log(output)
        }
      } else {
        console.log(output)
      }
    } catch (err) {
      UI.error(errorMessage(err))
      process.exit(1)
    }
  },
})
