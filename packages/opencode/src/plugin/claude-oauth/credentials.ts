import path from "path"
import os from "os"
import { writeFile } from "fs/promises"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://claude.ai/v1/oauth/token"
const CREDS_FILE = () => path.join(os.homedir(), ".claude", ".credentials.json")

interface Creds {
  access: string
  refresh: string
  expires: number
}

interface RawCreds {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
}

function parse(raw: RawCreds): Creds | undefined {
  const obj = raw.claudeAiOauth || raw
  if (!obj.accessToken || !obj.refreshToken || !obj.expiresAt) return undefined
  return { access: obj.accessToken, refresh: obj.refreshToken, expires: obj.expiresAt }
}

let cache: { creds: Creds; at: number } | undefined
let pending: Promise<Creds | undefined> | undefined

export async function read(): Promise<Creds | undefined> {
  if (process.platform === "darwin") {
    try {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        timeout: 2000,
      })
      const out = await new Response(proc.stdout).text()
      const code = await proc.exited

      if (code === 0) {
        const result = parse(JSON.parse(out.trim()))
        if (result) return result
      }
      // exit 44 = not found, 36 = locked, null = timeout — all fall through to file
    } catch {
      // Fall through to file
    }
  }

  const file = Bun.file(CREDS_FILE())
  if (!(await file.exists())) return undefined

  try {
    return parse((await file.json()) as RawCreds)
  } catch {
    return undefined
  }
}

export async function refresh(token: string): Promise<Creds | undefined> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: token,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) return undefined

    const json = (await res.json()) as TokenResponse
    const creds: Creds = {
      access: json.access_token || "",
      refresh: json.refresh_token || token,
      expires: Date.now() + (json.expires_in ?? 36000) * 1000,
    }
    if (!creds.access) return undefined

    // Persist to file with restricted permissions
    const file = CREDS_FILE()
    const existing = await Bun.file(file)
      .json()
      .catch(() => ({}))
    await writeFile(
      file,
      JSON.stringify({
        ...(existing as object),
        claudeAiOauth: {
          accessToken: creds.access,
          refreshToken: creds.refresh,
          expiresAt: creds.expires,
        },
      }),
      { mode: 0o600 },
    )

    return creds
  } catch {
    return undefined
  }
}

export async function cached(): Promise<Creds | undefined> {
  const now = Date.now()
  if (cache && now - cache.at < 30_000 && cache.creds.expires > now + 60_000) {
    return cache.creds
  }

  if (pending) return pending

  pending = (async () => {
    try {
      const creds = await read()
      if (!creds) return undefined

      if (creds.expires <= Date.now() + 60_000) {
        const refreshed = await refresh(creds.refresh)
        if (refreshed) {
          cache = { creds: refreshed, at: Date.now() }
          return refreshed
        }
      }

      cache = { creds, at: Date.now() }
      return creds
    } finally {
      pending = undefined
    }
  })()

  return pending
}

/** Force refresh credentials — used on 401 to get a fresh token */
export async function force(): Promise<Creds | undefined> {
  cache = undefined
  const old = await read()
  if (!old) return undefined
  const refreshed = await refresh(old.refresh)
  if (refreshed) {
    cache = { creds: refreshed, at: Date.now() }
    return refreshed
  }
  // Return existing if refresh fails but token still valid
  if (old.expires > Date.now()) {
    cache = { creds: old, at: Date.now() }
    return old
  }
  return undefined
}

export function clear() {
  cache = undefined
}
