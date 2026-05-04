# BroCode Jobs Design Spec

**Problem:** BroCode sessions are terminal-bound. If you close the terminal, the agent stops. There's no way to kick off a task, walk away, and come back later. The existing `delegate` tool solves part of this but uses API keys (expensive) and has no reattach capability.

**Goal:** BroCode gains a "jobs" system — background agent sessions that run in git worktrees, survive terminal close, support attach/detach, and use your Claude subscription (not API keys). Normal BroCode usage is unaffected.

**Scope:**
- In scope: background job lifecycle, daemon, attach/detach, notifications, worktree management
- Out of scope: Docker/container isolation (future enhancement), multi-machine/remote execution, CI integration

**Constraints:**
- Must use Claude subscription auth (not API keys)
- Must not change existing BroCode behavior when `jobs` subcommand isn't used
- Must work on macOS (primary) and Linux
- Built with Bun (matches BroCode's runtime)
- Parallel jobs should work (Claude subscription handles this fine)

**Success Criteria:**
- [ ] `brocode jobs new "prompt"` starts a background agent in a worktree
- [ ] `brocode jobs ls` shows running/done/stuck jobs with summary info
- [ ] `brocode jobs attach <id>` reconnects the TUI to a running or completed job
- [ ] Detaching from an attached job (hotkey) leaves the agent running
- [ ] macOS notification fires when a job completes, errors, or becomes idle
- [ ] Normal `brocode` (no `jobs` subcommand) works identically to today
- [ ] Job transcripts are readable after completion

## Design Decisions

### 1. "Jobs" not "sessions"

BroCode already has "sessions" (conversation threads). Background execution contexts are called **jobs** to avoid confusion. A job _contains_ a BroCode session — the job is the lifecycle wrapper, the session is the conversation.

### 2. Worktrees, not Docker (for now)

Docker adds significant complexity (image management, tool availability, mount configuration) and the primary motivation here is disconnect/reconnect — not isolation. Each job runs in a git worktree created by the daemon. Docker can be added later as an optional execution backend; the daemon architecture supports either.

### 3. Daemon as process manager

The daemon is a background Bun process that:
- Spawns BroCode child processes (one per job, each in its own worktree)
- Monitors their state (running, idle, exited)
- Multiplexes I/O between TUI clients and background processes
- Sends notifications
- Persists job metadata

The daemon auto-starts on first `brocode jobs` command and auto-stops when no jobs are running (or stays alive with a configurable idle timeout).

### 4. Attach/detach via existing transcripts

BroCode already persists session transcripts to disk. Reattaching to a job loads the transcript from disk (same as opening an existing session) and reconnects the I/O stream. No custom replay system needed.

### 5. Headless execution

Jobs run BroCode without a TUI attached. BroCode likely needs a headless/non-interactive mode where it processes a prompt and runs tools without terminal rendering. Output is captured by the daemon for later replay.

## Architecture

```
┌─────────────────────────────────────┐
│  Terminal                           │
│  BroCode TUI (attached to job)      │
│  - normal interactive experience    │
│  - hotkey to detach                 │
└──────────┬──────────────────────────┘
           │ Unix socket (IPC)
           ▼
┌─────────────────────────────────────┐
│  BroCode Jobs Daemon                │
│  - Spawns BroCode child processes   │
│  - Each in its own git worktree     │
│  - Tracks job state + session IDs   │
│  - Sends macOS notifications        │
│  - Persists job metadata (JSON)     │
│  - Auto-starts/stops                │
└──────┬──────────┬───────────────────┘
       │          │
       ▼          ▼
  ┌─────────┐ ┌─────────┐
  │WorktreeA│ │WorktreeB│
  │BroCode  │ │BroCode  │
  │(headless│ │(headless│
  │ process)│ │ process)│
  └─────────┘ └─────────┘
```

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
brocode jobs stop <id>                   # gracefully stop a job
brocode jobs rm <id>                     # remove job metadata + worktree
```

## Components

### 1. Job Metadata Store

Simple JSON file at `~/.config/brocode/jobs.json` (or similar):

```json
{
  "jobs": [
    {
      "id": "auth-flow-1714819200",
      "prompt": "implement auth flow",
      "repo": "/Users/me/dev/myproject",
      "worktree": "/Users/me/dev/myproject/.worktrees/job-auth-flow-1714819200",
      "branch": "jobs/auth-flow-1714819200",
      "sessionId": "abc123",
      "pid": 12345,
      "status": "running",
      "createdAt": "2026-05-04T10:00:00Z",
      "completedAt": null
    }
  ]
}
```

### 2. Daemon Process

- Starts on first `brocode jobs new` or `brocode jobs attach`
- Listens on a Unix socket (e.g., `/tmp/brocode-jobs.sock`)
- Manages child processes and their worktrees
- Monitors child process stdout for idle detection
- Sends notifications via `osascript` (macOS) or `notify-send` (Linux)
- Writes a PID file for lifecycle management

### 3. Headless BroCode Mode

BroCode needs to run without a TUI. Options (to be investigated):
- BroCode may already have a `--print` or non-interactive mode
- If not, needs a mode where it reads prompt, runs tools, writes transcript, without terminal rendering
- The daemon captures stdout/stderr for later replay

### 4. TUI Attach/Detach

**Attach flow:**
1. TUI connects to daemon via Unix socket
2. Daemon sends job metadata (session ID, status)
3. TUI loads session transcript from disk (existing BroCode mechanism)
4. Daemon pipes live stdout from the background process to the TUI
5. TUI pipes user input back to the background process

**Detach flow:**
1. User presses detach hotkey (e.g., `Ctrl+\` or configurable)
2. TUI disconnects from Unix socket
3. Background process continues running
4. TUI exits (or returns to job list)

### 5. Notification System

The daemon watches each child process:
- **Process exits (code 0)**: notification "Job X completed (N commits on branch Y)"
- **Process exits (non-zero)**: notification "Job X failed: [error summary]"
- **Idle timeout** (configurable, default 5 min): notification "Job X appears stuck — no output for 5 minutes"

Uses the same `osascript` approach as the existing `delegate` project's `notify.ts`.

### 6. Git Worktree Management

Each job gets a worktree:
- Created at job start: `git worktree add .worktrees/job-<id> -b jobs/<id>`
- Agent works on the branch `jobs/<id>`
- On job completion, worktree can be cleaned up or preserved (user choice)
- Cleanup: `git worktree remove` + `git branch -d`

## Open Questions (to resolve during implementation)

1. **Headless mode**: Does BroCode already support non-interactive execution? If not, what's the minimal change to support it?
2. **Stream multiplexing**: Exact protocol for piping I/O between daemon and TUI. Could be as simple as raw stdin/stdout forwarding over the Unix socket.
3. **Daemon lifecycle**: Auto-start is clear. Auto-stop policy: when last job finishes? After idle timeout? Keep alive indefinitely?
4. **Worktree cleanup**: Automatic on job removal? Or preserve by default so the user can inspect?
5. **Job naming**: Auto-generate from prompt (first few words) or require explicit names?

## Future Enhancements (out of scope for v1)

- **Docker execution backend**: Optional `--sandbox` flag to run jobs in Docker containers instead of bare worktrees. Same daemon, different process spawning strategy.
- **Remote execution**: Run the daemon on a remote machine, TUI connects over SSH/network. Would enable true "close laptop" scenarios.
- **Job queuing**: If Claude rate limits become an issue, queue jobs and run N at a time.
- **Job templates**: Predefined job types (implement plan, review PR, fix issue) with built-in prompts.
- **Web UI**: Browser-based job dashboard as an alternative to CLI.

## Context Files

- `packages/opencode/` — BroCode/OpenCode core (TUI, session management, providers)
- `/Users/broderick.westrope/dev/helse/delegate/` — existing delegate tool (Sandcastle + Docker pattern, notification system)
- `/Users/broderick.westrope/dev/helse/delegate/src/notify.ts` — macOS notification implementation
- `/Users/broderick.westrope/dev/helse/delegate/src/run.ts` — Sandcastle usage patterns
