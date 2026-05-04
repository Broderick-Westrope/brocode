# BroCode Jobs Design Spec

**Problem:** BroCode sessions are terminal-bound. If you close the terminal, the agent stops. There's no way to kick off a task, walk away, and come back later. The existing `delegate` tool solves part of this but uses API keys (expensive) and has no reattach capability.

**Goal:** BroCode gains a "jobs" system — background agent sessions that run in git worktrees, survive terminal close, support attach/detach, and use any BroCode-supported provider (including Claude subscription). Optionally, jobs can run inside Docker containers for isolation. Normal BroCode usage is unaffected.

**Scope:**
- In scope: background job lifecycle, attach/detach, worktree management, optional Docker isolation
- Deferred to v2: notifications, idle detection, multi-machine/remote execution, CI integration

**Constraints:**
- Must work with any provider BroCode supports (Claude subscription, API keys, OpenAI, etc.) — no provider-specific coupling
- Must not change existing BroCode behavior when `jobs` subcommand isn't used
- Must work on macOS (primary) and Linux
- Built with Bun (matches BroCode's runtime)
- Parallel jobs are expected to work (same as multiple terminal tabs)
- Docker is optional — jobs work without it installed

**Success Criteria:**
- [ ] `brocode jobs new "prompt"` starts a background agent in a worktree
- [ ] `brocode jobs new --docker "prompt"` starts a background agent in a Docker container
- [ ] `brocode jobs ls` shows running/done jobs with summary info
- [ ] `brocode jobs attach <id>` reconnects the TUI to a running or completed job
- [ ] Detaching from an attached job (hotkey) leaves the agent running
- [ ] Normal `brocode` (no `jobs` subcommand) works identically to today
- [ ] Job transcripts are readable after completion

## Design Decisions

### 1. "Jobs" not "sessions"

BroCode already has "sessions" (conversation threads). Background execution contexts are called **jobs** to avoid confusion. A job _contains_ a BroCode session — the job is the lifecycle wrapper, the session is the conversation.

### 2. Leverage existing `serve` + `run --attach` architecture

**Critical insight from review:** BroCode already has:
- `brocode serve` — starts a headless server on a port (per-request instance loading via `x-opencode-directory` header)
- `brocode run --attach <url>` — connects to a running server and streams events via SDK client
- Full SDK client for session lifecycle, event streaming, and permission handling
- `--dangerously-skip-permissions` for auto-approving permissions in non-interactive mode

**There is no need for a custom daemon.** Each job is a `brocode serve` process running in a worktree on a random port. A lightweight **job registry** tracks which ports and PIDs map to which jobs. The client side (`run --attach`) is identical regardless of whether the server is a bare process or inside Docker.

### 3. Docker as opt-in execution backend

The `serve`/`run --attach` architecture makes Docker nearly free to add. The HTTP interface between client and server is the same whether `serve` runs bare or in a container. The only difference is how the process is spawned.

**Without `--docker`:** `brocode serve` runs as a detached background process on the host.
**With `--docker`:** `brocode serve` runs inside a Docker container with worktree bind-mounted and port forwarded.

Both are transparent to `run --attach`. Docker is optional — if it's not installed, `--docker` errors with a clear message.

**What Docker gives you:**
- Filesystem isolation — agent can only touch the worktree, not your home directory
- Safe high permissions — `--dangerously-skip-permissions` is less dangerous when the agent is sandboxed
- Reproducible environment — consistent tool versions regardless of host
- Path toward remote execution (Docker runs anywhere)

### 4. Permissions: pause-and-notify on permission requests

**Bare jobs (no Docker):** Use the same permission settings the user already has configured in BroCode. If the agent hits a permission request that requires approval, the job pauses and waits. The user gets notified (v2, or discovers it via `jobs ls` showing "waiting" status) and attaches to the job to grant or deny permission. This matches the mental model of "same as running in my terminal, but I can walk away."

**Docker jobs:** More lenient defaults since the agent is sandboxed. Filesystem and shell operations within the container are pre-approved. Network access and anything that escapes the container still require approval. Exact permission boundaries TBD during implementation based on BroCode's existing permission categories.

**Job status:** The registry tracks a `"waiting"` status when a job is blocked on a permission request, distinct from `"running"` and `"done"`. `brocode jobs ls` surfaces this clearly so the user knows which jobs need attention.

### 5. Attach/detach via existing transcripts

BroCode already persists session transcripts to disk (SQLite via Drizzle). Reattaching to a job uses the existing session loading mechanism + `run --attach` to reconnect to the live server. No custom replay system needed.

### 6. Job metadata in SQLite (not JSON)

BroCode already uses SQLite (Drizzle) for persistence. The job registry uses the same pattern. A single JSON file has no locking and will corrupt under concurrent access.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Terminal                                    │
│  `brocode jobs attach <id>`                  │
│  → internally: `run --attach localhost:PORT`  │
└──────────┬───────────────────────────────────┘
           │ HTTP (existing SDK client)
           ▼
┌──────────────────────┐  ┌─────────────────────────────┐
│  brocode serve :4801 │  │  Docker container            │
│  (bare process)      │  │  ┌─────────────────────┐    │
│  (worktree A)        │  │  │ brocode serve :4802 │    │
│                      │  │  │ (worktree B mounted) │    │
└──────────────────────┘  │  └─────────────────────┘    │
                          │  port 4802 forwarded         │
                          └─────────────────────────────┘

Job Registry (SQLite):
  job-1 → port:4801, pid:12345, docker:false, worktree:/path/a, status:running
  job-2 → port:4802, pid:12346, docker:true,  container:abc123, status:running
```

**How it works:**
1. `brocode jobs new "prompt"` creates a git worktree, spawns `brocode serve` (bare or Docker), sends the prompt via SDK client, then detaches
2. The `serve` process runs in the background (detached process or Docker container)
3. `brocode jobs ls` reads the registry, checks PIDs/containers for liveness
4. `brocode jobs attach <id>` looks up the port, connects via SDK client, renders TUI
5. Detaching disconnects the SDK client — the `serve` process keeps running
6. On process exit, next `jobs ls` or `jobs attach` detects the dead PID/container and updates status

## CLI Surface

```bash
# Normal BroCode (unchanged)
brocode                                          # interactive TUI, same as today

# Jobs commands
brocode jobs new "implement auth flow"           # start a background job (bare process)
brocode jobs new --docker "implement auth flow"  # start a job in Docker
brocode jobs new --plan ./plan.md                # start from a plan file
brocode jobs new --dir /path/to/repo "prompt"    # target a specific repo
brocode jobs ls                                  # list all jobs
brocode jobs attach <id>                         # attach TUI to a job
brocode jobs log <id>                            # show transcript (non-interactive)
brocode jobs rm <id>                             # remove job metadata + worktree
```

## Components

### 1. Job Registry (SQLite)

Uses BroCode's existing Drizzle/SQLite stack. Schema:

```
jobs table:
  id            TEXT PRIMARY KEY    -- short slug (e.g., "auth-flow-a1b2c3")
  prompt        TEXT                -- original prompt or plan path
  repo          TEXT                -- source repo path
  worktree      TEXT                -- worktree path
  branch        TEXT                -- git branch name
  port          INTEGER             -- serve port
  pid           INTEGER             -- serve process PID
  session_id    TEXT                -- BroCode session ID
  status        TEXT                -- "running" | "waiting" | "done" | "failed" | "stopped"
  docker        INTEGER             -- 0 or 1
  container_id  TEXT                -- Docker container ID (nullable)
  created_at    INTEGER             -- unix timestamp
  completed_at  INTEGER             -- unix timestamp (nullable)
```

Location: `~/.config/brocode/jobs.db` (separate from per-project DBs since jobs span repos).

### 2. Job Lifecycle (`brocode jobs new`)

1. Validate target repo (cwd or `--dir <path>`)
2. Create git worktree: `git worktree add <worktree-path> -b jobs/<id>`
3. Find an available port (let OS assign with `:0`, capture from serve startup)
4. Spawn the serve process:
   - **Bare:** `brocode serve --port <port>` as a detached background process in the worktree
   - **Docker:** `docker run -d -p <port>:<port> -v <worktree>:/repo -v ~/.opencode:/home/agent/.opencode brocode-jobs serve --port <port>` (plus provider-specific auth mounts as needed)
5. Connect via SDK client, create a session, send the prompt
6. Start a lightweight background event watcher that subscribes to the `serve` event stream and updates the registry on status changes (e.g., `permission.asked` → set status to `"waiting"`, session complete → set status to `"done"`)
7. Write job metadata to the registry
8. Print: `Job <id> started on branch jobs/<id>`

### 3. Attach/Detach

**Attach:** `brocode jobs attach <id>`
1. Read registry → get port, check PID/container is alive
2. If alive: connect via SDK client (`run --attach localhost:<port>`), render TUI
3. If dead: mark job as done/failed, show transcript from session storage

**Detach:** Hotkey (e.g., `Ctrl+\`) during an attached session
1. Disconnect SDK client
2. `serve` process continues running
3. TUI exits or returns to shell

### 4. Job Event Watcher

Each job spawns a lightweight background process (or thread) that subscribes to the `serve` instance's event stream via the SDK client. Its only responsibilities:

- **`permission.asked` event:** Update registry status to `"waiting"`. (v2: send notification.)
- **Session complete / error:** Update registry status to `"done"` or `"failed"`. Record `completed_at`.
- **`serve` process exits unexpectedly:** Detect via PID/container check, mark as `"failed"`.

The watcher is minimal — it holds an open SSE connection and writes to SQLite on state transitions. If the watcher itself dies, `brocode jobs ls` falls back to PID/container liveness checks and the status just won't update in real-time until the user runs `attach` or `ls`.

**When the user attaches to a `"waiting"` job:** The TUI shows the pending permission request. The user approves or denies via the normal permission UI. The SDK client sends the `permission.reply`, the agent resumes, and the watcher updates status back to `"running"`.

### 5. Docker Image

A Dockerfile for jobs, built via `brocode jobs build-image`:

```dockerfile
FROM oven/bun:latest
RUN apt-get update && apt-get install -y git
COPY . /opt/brocode
WORKDIR /repo
ENTRYPOINT ["bun", "run", "/opt/brocode/packages/opencode/src/cli/index.ts"]
```

The image includes BroCode + Bun + git + common tools. Rebuilt when BroCode updates. The worktree is bind-mounted at `/repo`, auth credentials mounted read-only.

**Image management:**
- `brocode jobs build-image` — builds/rebuilds the Docker image
- Image name: `brocode-jobs:latest` (or configurable)
- First `--docker` run checks for the image and prompts to build if missing

### 5. Git Worktree Management

Each job gets a worktree:
- Created at `~/.config/brocode/worktrees/job-<id>` (NOT inside the repo, to avoid `.gitignore` issues and accidental deletion)
- Branch: `jobs/<id>`
- On `brocode jobs rm`: `git worktree remove` + optionally `git branch -d`
- Worktrees persist after job completion so the user can inspect results

### 6. Credential Safety

Jobs inherit whatever auth the user has configured in BroCode. The jobs system is provider-agnostic — it spawns `brocode serve`, which loads credentials from BroCode's standard auth storage (`~/.opencode/data/auth.json` and provider-specific files like `~/.claude/.credentials.json` for Claude OAuth).

**Race condition risk (OAuth providers):** Multiple parallel `serve` processes sharing credential files may race on token refresh (no file locking — 30-second in-memory cache is per-process only). This is unlikely in practice with 2-3 parallel jobs. If it becomes a problem, v2 adds a credential coordinator.

**API key providers:** No race condition risk — keys don't expire or refresh.

**Docker note:** Auth credential directories are mounted into Docker containers. For OAuth providers, if a refresh writes back to the credential file, the container needs write access to the mount. For API key providers, read-only mounts suffice. v1 mounts auth read-write for simplicity; v2 can tighten this.

**Monitoring:** If a job fails with an auth error, the user re-authenticates on the host and restarts the job.

## Open Questions (to resolve during implementation)

1. **Port allocation:** Let OS pick with `:0` and capture the actual port from serve startup output? Or random port from a range?
2. **`brocode serve` in background:** Does spawning `serve` as a detached child process work reliably on macOS? Need to handle stdout/stderr (redirect to log file).
3. **Instance bootstrapping:** `brocode serve` in a worktree needs to initialize a full `InstanceState`. Does it auto-detect the repo context from the worktree, or does it need flags?
4. **Job naming:** Auto-generate ID from prompt slug + random suffix (e.g., `auth-flow-a1b2c3`)? Or sequential numbering?
5. **Worktree cleanup:** `brocode jobs rm` should prompt before deleting a worktree with uncommitted changes.
6. **Docker auth mounts:** Which credential directories need to be mounted for each provider? BroCode's auth storage (`~/.opencode/data/`) is the baseline; Claude OAuth also needs `~/.claude/`. Need to enumerate provider-specific paths or mount a single auth directory.

## v2 Enhancements (deferred)

- **Notifications:** macOS/Linux notifications when jobs complete or fail. Monitor process exit and fire `osascript` / `notify-send`.
- **Idle detection:** Track agent activity via session events (not raw stdout). Notify if agent appears stuck.
- **Remote execution:** Run `serve` on a remote machine, TUI connects over network. Enables true "close laptop" scenarios.
- **Permission rulesets:** Per-job permission configuration (e.g., pre-approve specific tool categories, deny others) to reduce how often jobs enter `"waiting"` state.
- **Job queuing:** If Claude rate limits become an issue, queue jobs and run N at a time.
- **Docker image customization:** Per-repo Dockerfiles for project-specific tools (like Sandcastle's `.sandcastle/Dockerfile` pattern).

## Context Files

- `packages/opencode/src/cli/cmd/serve.ts` — existing headless server command
- `packages/opencode/src/cli/cmd/run.ts` — existing non-interactive execution + `--attach`
- `packages/opencode/src/plugin/claude-oauth/credentials.ts` — Claude OAuth credential handling (30s cache, no file locking)
- `packages/opencode/src/provider/auth.ts` — Provider auth method orchestration (supports multiple auth types)
- `packages/opencode/src/auth/index.ts` — Auth storage (`~/.opencode/data/auth.json`)
- `packages/opencode/` — BroCode/OpenCode core (TUI, session management, providers)
- `packages/sdk/js/src/v2/client.ts` — SDK client factory for connecting to serve
- `/Users/broderick.westrope/dev/helse/delegate/` — existing delegate tool (Sandcastle patterns, notifications)
- `/Users/broderick.westrope/dev/helse/delegate/src/notify.ts` — macOS notification implementation
