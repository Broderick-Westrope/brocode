import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"

export function DialogTree(props: {
  sessionID: string
  leafID?: string
  onBranch: (messageID: string, prompt?: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    if (!messages.length) return []

    // Build children map and message lookup for tree traversal
    const msgMap = new Map(messages.map((m) => [m.id, m]))
    const childrenMap = new Map<string | null, typeof messages>()
    for (const msg of messages) {
      const parentID = msg.treeParentID ?? null
      if (!childrenMap.has(parentID)) childrenMap.set(parentID, [])
      childrenMap.get(parentID)!.push(msg)
    }

    // Find ancestor path to highlight the current branch
    const ancestorSet = new Set<string>()
    if (props.leafID) {
      let current: string | undefined = props.leafID
      while (current) {
        ancestorSet.add(current)
        current = msgMap.get(current)?.treeParentID
      }
    }

    // Find compacted messages on the current branch.
    // A completed compaction: user message with a compaction part that has tail_start_id,
    // followed by an assistant with summary=true and finish set. Everything before
    // tail_start_id on the branch is compacted (not visible to the LLM).
    const compactedSet = new Set<string>()
    if (ancestorSet.size > 0) {
      const ancestorList = [...ancestorSet]
      const msgMap = new Map(messages.map((m) => [m.id, m]))
      // Walk from leaf towards root, find the latest compaction boundary
      for (const id of ancestorList) {
        const msg = msgMap.get(id)
        if (msg?.role !== "user") continue
        const parts = sync.data.part[msg.id] ?? []
        const compactionPart = parts.find((p) => p.type === "compaction" && p.tail_start_id) as
          | { type: "compaction"; tail_start_id: string }
          | undefined
        if (!compactionPart) continue
        // Check that the paired assistant response completed the summary
        const childMsgs = childrenMap.get(msg.id) ?? []
        const summaryAssistant = childMsgs.find(
          (m) => m.role === "assistant" && m.summary && m.finish && !m.error,
        )
        if (!summaryAssistant) continue
        // Found a completed compaction — mark everything before tail_start_id as compacted
        const tailID = compactionPart.tail_start_id
        let foundTail = false
        for (const ancestorID of ancestorList) {
          if (ancestorID === tailID) foundTail = true
          if (foundTail) break
          compactedSet.add(ancestorID)
        }
        break // only need the latest compaction
      }
    }

    // Walk the continuation chain from a first assistant to find the last
    // assistant in the same logical response (for preview text and navigation).
    function lastContinuation(startID: string) {
      let current = msgMap.get(startID)!
      while (true) {
        const next = (childrenMap.get(current.id) ?? []).find((c) => c.role === "assistant")
        if (!next) break
        const parent = next.treeParentID ? msgMap.get(next.treeParentID) : undefined
        if (parent?.role !== "assistant") break
        current = next
      }
      return current
    }

    function assistantPreview(msg: (typeof messages)[0]) {
      const parts = sync.data.part[msg.id] ?? []
      const textPart = parts.findLast((p) => p.type === "text" && !p.synthetic) as TextPart | undefined
      if (textPart?.text) return textPart.text.replace(/\n/g, " ").slice(0, 60)
      const toolPart = parts.find((p) => p.type === "tool") as ToolPart | undefined
      if (toolPart) return `[tool: ${toolPart.tool}]`
      return "[response]"
    }

    const result: DialogSelectOption<string>[] = []

    function walk(parentID: string | null, depth: number) {
      const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => a.time.created - b.time.created)
      for (const msg of children) {
        // Skip continuation assistants (tool-call loop iterations whose
        // treeParentID points to another assistant) — they're part of the
        // same logical response and not meaningful branch points.
        const parentMsg = msg.treeParentID ? msgMap.get(msg.treeParentID) : undefined
        if (msg.role === "assistant" && parentMsg?.role === "assistant") {
          walk(msg.id, depth)
          continue
        }

        const indent = "  ".repeat(depth)
        const isCompacted = compactedSet.has(msg.id)
        const branchMarker = isCompacted ? "○ " : ancestorSet.has(msg.id) ? "● " : "  "
        const role = msg.role === "user" ? "U" : "A"

        // For assistants, resolve the last continuation in the chain so the
        // preview shows actual output text and navigation lands at the end
        // of the full response (not the first tool-call message).
        const tail = msg.role === "assistant" ? lastContinuation(msg.id) : undefined

        let preview = ""
        if (msg.role === "user") {
          const parts = sync.data.part[msg.id] ?? []
          const isCompaction = parts.some((p) => p.type === "compaction")
          const isBranchSummary = parts.some((p) => p.type === "branch_summary")
          if (isCompaction) {
            preview = "[compaction]"
          } else if (isBranchSummary) {
            preview = "[branch summary]"
          } else {
            const textPart = parts.find((p) => p.type === "text" && !p.synthetic && !p.ignored) as TextPart | undefined
            preview = textPart?.text?.replace(/\n/g, " ")?.slice(0, 60) ?? "[no text]"
          }
        } else {
          // Show preview from the tail (last continuation), falling back to this message
          preview = assistantPreview(tail ?? msg)
          if (preview === "[response]" && tail && tail.id !== msg.id) preview = assistantPreview(msg)
        }

        const isLeaf = tail ? tail.id === props.leafID || msg.id === props.leafID : msg.id === props.leafID
        const hasBranches = (childrenMap.get(msg.id)?.length ?? 0) > 1

        result.push({
          title: `${indent}${branchMarker}${role}: ${preview}${isLeaf ? " ← current" : ""}${hasBranches ? " ⑂" : ""}`,
          value: tail?.id ?? msg.id,
          footer: Locale.time(msg.time.created),
          onSelect: (dialog) => {
            if (msg.role === "user") {
              const parts = sync.data.part[msg.id] ?? []
              const prompt = parts.reduce(
                (agg, part) => {
                  if (part.type === "text" && !part.synthetic) agg.input += part.text
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.onBranch(msg.treeParentID ?? msg.id, prompt)
            } else {
              props.onBranch(tail?.id ?? msg.id)
            }
            dialog.clear()
          },
        })

        walk(msg.id, depth + 1)
      }
    }

    walk(null, 0)
    return result
  })

  return (
    <DialogSelect
      title="Session Tree"
      options={options()}
      placeholder="Filter messages · Enter to select · Esc to cancel"
    />
  )
}
