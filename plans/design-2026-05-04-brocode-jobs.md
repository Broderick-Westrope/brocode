# BroCode Jobs Design Spec

**Problem:** BroCode sessions are terminal-bound. If you close the terminal, the agent stops. There's no way to kick off a task, walk away, and come back later. The existing `delegate` tool solves part of this but uses API keys (expensive) and has no reattach capability.

**Goal:** BroCode gains a "jobs" system — background agent sessions that run in git worktrees, survive terminal close, support attach/detach, and use your Claude subscription (not API keys). Normal BroCode usage is unaffected.

**Scope:**
- In scope: background job lifecycle, attach/detach, worktree management
- Deferred to v2: notifications, idle detection, Docker/container isolation, multi-machine/remote execution, CI integration

**Constraints:**
- Must use Claude subscription auth (not API keys)
- Must not change existing BroCode behavior when `jobs` subcommand isn't used
- Must work on macOS (primary) and Linux
- Built with Bun (matches BroCode's runtime)
- Parallel jobs are expected to work (same as multiple terminal tabs)

**Success Criteria:**
- [ ] `brocode jobs new "prompt"` starts a background agent in a worktree
- [ ] `brocode jobs ls` shows running/done jobs with summary info
- [ ] `brocode jobs attach <id>` reconnects the TUI to a running or completed job
- [ ] Detaching from an attached job (hotkey) leaves the agent running
- [ ] Normal `brocode` (no `jobs` subcommand) works identically to today
- [ ] Job transcripts are readable after completion

## Design Decisions

### 1. "Jobs" not "sessions"

BroCode already has "sessions" (conversation threads). Background execution contexts are called **jobs** to avoid confusion. A job _contains_ a BroCode session — the job is the lifecycle wrapper, the session is the conversation.

### 2. Worktrees, not Docker (for now)

Docker adds significant complexity (image management, tool availability, mount configuration) and the primary motivation here is disconnect/reconnect — not isolation. Each job runs in a git worktree. Docker can be added later as an optional execution backend.

### 3. Leverage existing `serve` + `run --attach` architecture

**Critical insight from review:** BroCode already has:
- `brocode serve` — starts a headless server on a port
- `brocode run --attach` — connects to a running server and streams events via SDK
- Full SDK client for session lifecycle, event streaming, and permission handling

**There is no need for a custom daemon.** Each job is simply a `brocode serve` process running in a worktree on a random port. A lightweight **job registry** (not a daemon) tracks which ports and PIDs map to which jobs. This eliminates custom IPC, I/O multiplexing, and process supervision.

### 4. Permissions: auto-approve for background jobs

Background jobs will deadlock if they hit a permission prompt with no TUI attached. For v1, jobs run with auto-approve (equivalent to `--dangerously-skip-permissions`). The user explicitly starts a job knowing it will run unattended — this is an implicit trust grant. A permission ruleset system can be added in v2.

### 5. Attach/detach via existing transcripts

BroCode already persists session transcripts to disk. Reattaching to a job uses the existing session loading mechanism + `run --attach` to reconnect to the live server. No custom replay system needed.

### 6. Job metadata in SQLite (not JSON)

BroCode already uses SQLite (Drizzle) for persistence. The job registry should use the same pattern. A single JSON file has no locking and will corrupt under concurrent access.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Terminal                                   │
│  BroCode TUI                                │
│  `brocode jobs attach <id>`                 │
│  → internally: `run --attach localhost:PORT` │
└──────────┬──────────────────────────────────┘
           │ HTTP (existing SDK client)
           ▼
┌──────────────────────┐  ┌──────────────────────┐
│  brocode serve :4801 │  │  brocode serve :4802 │
│  (worktree A)        │  │  (worktree B)        │
│  (background proc)   │  │  (background proc)   │
└──────────────────────┘  └──────────────────────┘

Job Registry (SQLite):
  job-1 → port:4801, pid:12345, worktree:/path/a, status:running
  job-2 → port:4802, pid:12346, worktree:/path/b, status:done
```

**How it works:**
1. `brocode jobs new "prompt"` creates a git worktree, spawns `brocode serve` on a random port inside it, sends the prompt via SDK client, then detaches
2. The `serve` process runs as a background process (detached from terminal)
3. `brocode jobs ls` reads the registry, checks PIDs for liveness
4. `brocode jobs attach <id>` looks up the port, connects via SDK client, renders TUI
5. Detaching disconnects the SDK client — the `serve` process keeps running
6. On process exit, next `jobs ls` or `jobs attach` detects the dead PID and updates status

## CLI Surface

```bash
# Normal BroCode (unchanged)
brocode                          # interactive TUI, same as today

# Jobs commands
brocode jobs new "implement auth flow"   # start a background job
brocode jobs new --plan ./plan.md        # start from a plan file
brocode jobs ls                          # list all jobs
brocode jobs attach <id>                 # attach TUI to a job
brocode jobs log <id>                    # show transcript (non-interactive)
brocode jobs rm <id>                     # remove job metadata + worktree
```

## Components

### 1. Job Registry (SQLite)

Uses BroCode's existing Drizzle/SQLite stack. Schema:

```
jobs table:
  id          TEXT PRIMARY KEY    -- short slug (e.g., "auth-flow-a1b2c3")
  prompt      TEXT                -- original prompt or plan path
  repo        TEXT                -- source repo path
  worktree    TEXT                -- worktree path
  branch      TEXT                -- git branch name
  port        INTEGER             -- serve port
  pid         INTEGER             -- serve process PID
  session_id  TEXT                -- BroCode session ID
  status      TEXT                -- "running" | "done" | "failed" | "stopped"
  created_at  INTEGER             -- unix timestamp
  completed_at INTEGER            -- unix timestamp (nullable)
```

Location: `~/.config/brocode/jobs.db` (separate from per-project DBs since jobs span repos).

### 2. Job Lifecycle (`brocode jobs new`)

1. Validate target repo (cwd or `--dir <path>`)
2. Create git worktree: `git worktree add <worktree-path> -b jobs/<id>`
3. Find an available port
4. Spawn `brocode serve --port <port>` in the worktree as a detached background process
5. Connect via SDK client, create a session, send the prompt
6. Disconnect the SDK client (the serve process continues)
7. Write job metadata to the registry
8. Print: `Job <id> started on branch jobs/<id>`

### 3. Attach/Detach

**Attach:** `brocode jobs attach <id>`
1. Read registry → get port, check PID is alive
2. If alive: connect via SDK client (`run --attach localhost:<port>`), render TUI
3. If dead: mark job as done/failed, show transcript from session storage

**Detach:** Hotkey (e.g., `Ctrl+\`) during an attached session
1. Disconnect SDK client
2. `serve` process continues running
3. TUI exits or returns to shell

### 4. Git Worktree Management

Each job gets a worktree:
- Created at `~/.config/brocode/worktrees/job-<id>` (NOT inside the repo, to avoid `.gitignore` issues and accidental deletion)
- Branch: `jobs/<id>`
- On `brocode jobs rm`: `git worktree remove` + optionally `git branch -d`
- Worktrees persist after job completion so the user can inspect results

### 5. OAuth Credential Safety

**Risk:** Multiple parallel `serve` processes sharing `~/.claude/.credentials.json` may race on token refresh (no file locking in BroCode's credential code).

**v1 mitigation:** Accept the race condition risk — it's unlikely in practice with 2-3 parallel jobs and 30-second cache windows. If it becomes a problem, v2 adds a credential coordinator (single process that handles refresh, jobs request tokens from it).

**Monitoring:** If a job fails with "credentials expired," the user re-authenticates (`claude` CLI) and restarts the job.

## Open Questions (to resolve during implementation)

1. **Port allocation:** Random port from a range (e.g., 4800-4899)? Or let OS pick with `:0` and capture the actual port from serve startup output?
2. **`brocode serve` in background:** Does spawning `serve` as a detached child process work reliably on macOS? Need to handle stdout/stderr (redirect to log file).
3. **Instance bootstrapping:** `brocode serve` in a worktree needs to initialize a full `InstanceState`. Does it auto-detect the repo context from the worktree, or does it need flags?
4. **Job naming:** Auto-generate ID from prompt slug + random suffix (e.g., `auth-flow-a1b2c3`)? Or sequential numbering?
5. **Worktree cleanup:** `brocode jobs rm` should prompt before deleting a worktree with uncommitted changes.

## v2 Enhancements (deferred)

- **Notifications:** macOS/Linux notifications when jobs complete or fail. Monitor process exit and fire `osascript` / `notify-send`.
- **Idle detection:** Track agent activity via session events (not raw stdout). Notify if agent appears stuck.
- **Docker execution backend:** Optional `--sandbox` flag to run jobs in Docker containers instead of bare worktrees.
- **Remote execution:** Run `serve` on a remote machine, TUI connects over network. Enables true "close laptop" scenarios.
- **Permission rulesets:** Per-job permission configuration instead of blanket auto-approve.
- **Job queuing:** If Claude rate limits become an issue, queue jobs and run N at a time.

## Context Files

- `packages/opencode/src/cli/cmd/serve.ts` — existing headless server command
- `packages/opencode/src/cli/cmd/run.ts` — existing non-interactive execution + `--attach`
- `packages/opencode/src/provider/credentials.ts` — Claude OAuth credential handling
- `packages/opencode/` — BroCode/OpenCode core (TUI, session management, providers)
- `/Users/broderick.westrope/dev/helse/delegate/` — existing delegate tool (Sandcastle patterns, notifications)
- `/Users/broderick.westrope/dev/helse/delegate/src/notify.ts` — macOS notification implementation
