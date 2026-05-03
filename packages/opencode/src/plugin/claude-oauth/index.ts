import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../../auth"
import * as Log from "@opencode-ai/core/util/log"
import * as credentials from "./credentials"
import * as billing from "./billing"

const log = Log.create({ service: "plugin.claude-oauth" })

const VERSION = () => process.env.ANTHROPIC_CLI_VERSION ?? "2.1.90"
const DEFAULT_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05"

function cloneHeaders(init?: RequestInit): Headers {
  const headers = new Headers()
  if (!init?.headers) return headers
  if (init.headers instanceof Headers) {
    init.headers.forEach((v: string, k: string) => headers.set(k, v))
    return headers
  }
  if (Array.isArray(init.headers)) {
    for (const [k, v] of init.headers) {
      if (v !== undefined) headers.set(k, String(v))
    }
    return headers
  }
  for (const [k, v] of Object.entries(init.headers)) {
    if (v !== undefined) headers.set(k, String(v))
  }
  return headers
}

function mergeFlags(headers: Headers): string {
  const flags = process.env.ANTHROPIC_BETA_FLAGS ?? DEFAULT_BETA
  const existing = headers.get("anthropic-beta")
  if (!existing) return flags
  return [...new Set([...flags.split(","), ...existing.split(",")])].join(",")
}

export async function ClaudeOAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return {}

        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(url: RequestInfo | URL, init?: RequestInit) {
            log.debug("oauth fetch", { url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url })
            const creds = await credentials.cached()
            if (!creds) throw new Error("Claude Code credentials not found. Run `claude` to authenticate.")

            const headers = cloneHeaders(init)
            headers.set("Authorization", `Bearer ${creds.access}`)
            headers.set("anthropic-version", "2023-06-01")
            headers.set("user-agent", `claude-cli/${VERSION()} (external, cli)`)
            headers.set("anthropic-beta", mergeFlags(headers))
            headers.set("x-app", "cli")
            headers.delete("x-api-key")

            const res = await fetch(url, { ...init, headers })

            // Single retry on 401: refresh credentials and retry once.
            // If the refreshed token also 401s, the response propagates to the caller.
            if (res.status === 401) {
              const refreshed = await credentials.force()
              if (!refreshed) throw new Error("Claude Code credentials expired. Run `claude` to re-authenticate.")
              headers.set("Authorization", `Bearer ${refreshed.access}`)
              return fetch(url, { ...init, headers })
            }

            return res
          },
        }
      },
      methods: [
        {
          label: "Claude Code (OAuth)",
          type: "oauth",
          async authorize() {
            const creds = await credentials.read()
            if (!creds) {
              return {
                url: "",
                instructions:
                  "Claude Code credentials not found. Run `claude` in your terminal to authenticate, then try again.",
                method: "auto" as const,
                callback: async () => ({ type: "failed" as const }),
              }
            }

            return {
              url: "",
              instructions: "Using Claude Code credentials.",
              method: "auto" as const,
              callback: async () => ({
                type: "success" as const,
                provider: "anthropic",
                refresh: creds.refresh,
                access: creds.access,
                expires: creds.expires,
              }),
            }
          },
        },
        {
          label: "API Key",
          type: "api" as const,
        },
      ],
    },
    "experimental.chat.system.transform": async (_input, output) => {
      // Only activate when OAuth credentials are available
      const creds = await credentials.cached()
      if (!creds) return

      // Prepend Claude Code identity
      if (!output.system.some((s) => s.includes("You are Claude Code"))) {
        output.system.unshift("You are Claude Code, Anthropic's official CLI for Claude.")
      }

      // Billing header uses system prompt text for cch derivation since
      // the system.transform hook doesn't have access to user messages
      const text = output.system.join("\n")
      output.system.unshift(billing.compute(text, VERSION(), "cli"))
    },
  }
}
