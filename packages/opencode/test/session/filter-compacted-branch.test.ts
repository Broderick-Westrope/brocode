import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const modelRef = { providerID, modelID: ModelID.make("test") }

let counter = 0
function nextID() {
  counter++
  return String(counter).padStart(8, "0")
}

function userMsg(
  id: string,
  opts?: { treeParentID?: string; parts?: MessageV2.Part[] },
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: modelRef,
      treeParentID: opts?.treeParentID ? MessageID.make(opts.treeParentID) : undefined,
    } as MessageV2.User,
    parts: opts?.parts ?? [
      {
        id: PartID.make(nextID()),
        sessionID,
        messageID: MessageID.make(id),
        type: "text",
        text: "user message",
      } as MessageV2.TextPart,
    ],
  }
}

function assistantMsg(
  id: string,
  parentID: string,
  opts?: {
    treeParentID?: string
    finish?: string
    summary?: boolean
    parts?: MessageV2.Part[]
  },
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      parentID: MessageID.make(parentID),
      treeParentID: opts?.treeParentID ? MessageID.make(opts.treeParentID) : undefined,
      time: { created: 0 },
      finish: opts?.finish ?? "stop",
      summary: opts?.summary,
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      modelID: ModelID.make("test"),
      providerID,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts: opts?.parts ?? [
      {
        id: PartID.make(nextID()),
        sessionID,
        messageID: MessageID.make(id),
        type: "text",
        text: "assistant response",
      } as MessageV2.TextPart,
    ],
  }
}

function compactionUserMsg(
  id: string,
  opts: { treeParentID: string; tailStartID?: string },
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: modelRef,
      treeParentID: MessageID.make(opts.treeParentID),
    } as MessageV2.User,
    parts: [
      {
        id: PartID.make(nextID()),
        sessionID,
        messageID: MessageID.make(id),
        type: "compaction",
        auto: false,
        tail_start_id: opts.tailStartID ? MessageID.make(opts.tailStartID) : undefined,
      } as MessageV2.CompactionPart,
    ],
  }
}

function compactionAssistantMsg(
  id: string,
  parentID: string,
  opts?: { treeParentID?: string },
): MessageV2.WithParts {
  return assistantMsg(id, parentID, {
    treeParentID: opts?.treeParentID ?? parentID,
    finish: "stop",
    summary: true,
    parts: [
      {
        id: PartID.make(nextID()),
        sessionID,
        messageID: MessageID.make(id),
        type: "text",
        text: "Summary of conversation so far...",
      } as MessageV2.TextPart,
    ],
  })
}

function toolPart(messageID: string, status: "completed" | "error" | "pending" | "running"): MessageV2.ToolPart {
  const base = {
    id: PartID.make(nextID()),
    sessionID,
    messageID: MessageID.make(messageID),
    type: "tool" as const,
    tool: "bash",
    callID: nextID(),
  }
  if (status === "completed") {
    return {
      ...base,
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "file.ts",
        title: "bash",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    } as MessageV2.ToolPart
  }
  if (status === "error") {
    return {
      ...base,
      state: { status: "error", input: { command: "ls" }, error: "fail", time: { start: 0, end: 1 } },
    } as MessageV2.ToolPart
  }
  return {
    ...base,
    state: { status, input: { command: "ls" }, time: { start: 0 } },
  } as MessageV2.ToolPart
}

/**
 * Simulates what filterCompactedEffect does: takes messages in root→leaf
 * (streamBranch) order, reverses, calls filterCompacted.
 */
function filterBranch(rootToLeaf: MessageV2.WithParts[]) {
  return MessageV2.filterCompacted([...rootToLeaf].reverse())
}

/** Extract plain string IDs for easy assertion. */
function ids(msgs: MessageV2.WithParts[]): string[] {
  return msgs.map((m) => m.info.id as string)
}

/**
 * Extracts the break-condition inputs from the filtered messages,
 * matching the runLoop's scan logic.
 */
function scanForBreak(msgs: MessageV2.WithParts[]) {
  let lastUser: MessageV2.User | undefined
  let lastAssistant: MessageV2.Assistant | undefined
  let lastFinished: MessageV2.Assistant | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
    if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
    if (!lastFinished && msg.info.role === "assistant" && (msg.info as MessageV2.Assistant).finish)
      lastFinished = msg.info as MessageV2.Assistant
    if (lastUser && lastFinished) break
  }

  const lastAssistantMsg = msgs.findLast(
    (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
  )
  const hasToolCalls =
    lastAssistantMsg?.parts.some(
      (part) =>
        part.type === "tool" &&
        !(part as MessageV2.ToolPart).metadata?.providerExecuted &&
        (part as MessageV2.ToolPart).state.status !== "completed" &&
        (part as MessageV2.ToolPart).state.status !== "error",
    ) ?? false

  const lastUserIdx = msgs.findLastIndex((m) => m.info.role === "user")
  const lastAssistantIdx = msgs.findLastIndex((m) => m.info.role === "assistant")
  const shouldBreak =
    !!lastAssistant?.finish && !hasToolCalls && lastUserIdx < lastAssistantIdx

  return {
    lastUser,
    lastAssistant,
    lastAssistantID: lastAssistant?.id as string | undefined,
    lastFinished,
    hasToolCalls,
    shouldBreak,
  }
}

describe("filterCompacted after branchTo + compaction", () => {
  test("no tail: loop breaks after compaction", () => {
    // Simple case: compaction without a tail (short history)
    // IDs are chronologically ordered (like ULIDs)
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", { treeParentID: "01" }),
      compactionUserMsg("03", { treeParentID: "02" }),
      compactionAssistantMsg("04", "03"),
    ]

    const filtered = filterBranch(msgs)
    expect(ids(filtered)).toContain("03")
    expect(ids(filtered)).toContain("04")

    const scan = scanForBreak(filtered)
    expect(scan.shouldBreak).toBe(true)
  })

  test("with tail: loop breaks when tail ends with finished assistant", () => {
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", { treeParentID: "01" }),
      userMsg("03", { treeParentID: "02" }),
      assistantMsg("04", "03", { treeParentID: "03" }),
      userMsg("05", { treeParentID: "04" }),
      assistantMsg("06", "05", { treeParentID: "05", finish: "stop" }),
      compactionUserMsg("07", { treeParentID: "06", tailStartID: "03" }),
      compactionAssistantMsg("08", "07"),
    ]

    const filtered = filterBranch(msgs)
    const scan = scanForBreak(filtered)
    expect(scan.shouldBreak).toBe(true)
  })

  test("with tail ending in continuation assistant with finish=tool-calls and completed tools", () => {
    // Bug scenario: tail's last assistant is a continuation with
    // finish="tool-calls" but all tool calls already completed.
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", {
        treeParentID: "01",
        finish: "tool-calls",
        parts: [toolPart("02", "completed")],
      }),
      assistantMsg("03", "01", {
        treeParentID: "02",
        finish: "stop",
        parts: [
          {
            id: PartID.make(nextID()),
            sessionID,
            messageID: MessageID.make("03"),
            type: "text",
            text: "continuation response",
          } as MessageV2.TextPart,
        ],
      }),
      userMsg("04", { treeParentID: "03" }),
      assistantMsg("05", "04", { treeParentID: "04", finish: "stop" }),
      compactionUserMsg("06", { treeParentID: "05", tailStartID: "01" }),
      compactionAssistantMsg("07", "06"),
    ]

    const filtered = filterBranch(msgs)
    expect(ids(filtered)).toContain("01")
    expect(ids(filtered)).toContain("02")

    const scan = scanForBreak(filtered)
    expect(scan.hasToolCalls).toBe(false)
    expect(scan.shouldBreak).toBe(true)
  })

  test("with tail ending in continuation assistant with pending tool calls: loop continues", () => {
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", {
        treeParentID: "01",
        finish: "tool-calls",
        parts: [toolPart("02", "pending")],
      }),
      compactionUserMsg("03", { treeParentID: "02", tailStartID: "01" }),
      compactionAssistantMsg("04", "03"),
    ]

    const filtered = filterBranch(msgs)
    const scan = scanForBreak(filtered)

    expect(scan.hasToolCalls).toBe(true)
    expect(scan.shouldBreak).toBe(false)
  })

  test("filterCompacted reorders: compaction pair comes before tail", () => {
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", { treeParentID: "01" }),
      userMsg("03", { treeParentID: "02" }),
      assistantMsg("04", "03", { treeParentID: "03" }),
      compactionUserMsg("05", { treeParentID: "04", tailStartID: "03" }),
      compactionAssistantMsg("06", "05"),
    ]

    const filtered = filterBranch(msgs)
    expect(ids(filtered)).toEqual(["05", "06", "03", "04"])
  })

  test("tail with multiple continuation assistants: last one determines break", () => {
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", {
        treeParentID: "01",
        finish: "tool-calls",
        parts: [toolPart("02", "completed")],
      }),
      assistantMsg("03", "01", {
        treeParentID: "02",
        finish: "tool-calls",
        parts: [toolPart("03", "completed")],
      }),
      assistantMsg("04", "01", {
        treeParentID: "03",
        finish: "stop",
        parts: [
          {
            id: PartID.make(nextID()),
            sessionID,
            messageID: MessageID.make("04"),
            type: "text",
            text: "final response",
          } as MessageV2.TextPart,
        ],
      }),
      compactionUserMsg("05", { treeParentID: "04", tailStartID: "01" }),
      compactionAssistantMsg("06", "05"),
    ]

    const filtered = filterBranch(msgs)
    const scan = scanForBreak(filtered)

    expect(scan.lastAssistantID).toBe("04")
    expect(scan.shouldBreak).toBe(true)
  })

  test("old ID comparison would fail when tail has only assistant continuations", () => {
    // Real scenario: tail is a continuation chain (assistants only, no user).
    // After reordering: [compaction_user(NEW), compaction_assistant(NEW), A1(OLD), A2(OLD)]
    // lastUser=compaction_user (new ULID "z_01"), lastAssistant=A2 (old ULID "a_04")
    // Old check: "z_01" < "a_04" → false (z > a) → loop doesn't break
    const msgs = [
      userMsg("a_01"),
      assistantMsg("a_02", "a_01", { treeParentID: "a_01", finish: "tool-calls", parts: [toolPart("a_02", "completed")] }),
      assistantMsg("a_03", "a_01", { treeParentID: "a_02", finish: "tool-calls", parts: [toolPart("a_03", "completed")] }),
      assistantMsg("a_04", "a_01", { treeParentID: "a_03", finish: "stop" }),
      compactionUserMsg("z_01", { treeParentID: "a_04", tailStartID: "a_02" }),
      compactionAssistantMsg("z_02", "z_01"),
    ]

    const filtered = filterBranch(msgs)
    const scan = scanForBreak(filtered)

    // New positional comparison works correctly
    expect(scan.shouldBreak).toBe(true)

    // Old lexicographic comparison would fail:
    const oldShouldBreak =
      !!scan.lastAssistant?.finish &&
      !scan.hasToolCalls &&
      !!scan.lastUser &&
      scan.lastUser.id < scan.lastAssistant.id
    expect(oldShouldBreak).toBe(false)
  })

  test("tail ending with continuation that has finish=tool-calls and completed tools", () => {
    // Edge case: the very LAST message in the tail has finish="tool-calls"
    // but completed tools. Subsequent messages were compacted away.
    const msgs = [
      userMsg("01"),
      assistantMsg("02", "01", {
        treeParentID: "01",
        finish: "tool-calls",
        parts: [toolPart("02", "completed")],
      }),
      assistantMsg("03", "01", {
        treeParentID: "02",
        finish: "tool-calls",
        parts: [toolPart("03", "completed")],
      }),
      compactionUserMsg("04", { treeParentID: "03", tailStartID: "01" }),
      compactionAssistantMsg("05", "04"),
    ]

    const filtered = filterBranch(msgs)
    expect(ids(filtered)).toEqual(["04", "05", "01", "02", "03"])

    const scan = scanForBreak(filtered)

    expect(scan.lastAssistantID).toBe("03")
    expect(scan.hasToolCalls).toBe(false)
    expect(scan.shouldBreak).toBe(true)
  })
})
