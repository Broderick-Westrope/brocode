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

    // Build children map for tree traversal
    const childrenMap = new Map<string | null, typeof messages>()
    for (const msg of messages) {
      const parentID = msg.treeParentID ?? null
      if (!childrenMap.has(parentID)) childrenMap.set(parentID, [])
      childrenMap.get(parentID)!.push(msg)
    }

    // Find ancestor path to highlight the current branch
    const ancestorSet = new Set<string>()
    if (props.leafID) {
      const msgMap = new Map(messages.map((m) => [m.id, m]))
      let current: string | undefined = props.leafID
      while (current) {
        ancestorSet.add(current)
        current = msgMap.get(current)?.treeParentID
      }
    }

    const result: DialogSelectOption<string>[] = []

    function walk(parentID: string | null, depth: number) {
      const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => a.time.created - b.time.created)
      for (const msg of children) {
        const indent = "  ".repeat(depth)
        const onCurrentBranch = ancestorSet.has(msg.id) ? "● " : "  "
        const role = msg.role === "user" ? "U" : "A"

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
          const parts = sync.data.part[msg.id] ?? []
          const toolPart = parts.find((p) => p.type === "tool") as ToolPart | undefined
          const textPart = parts.find((p) => p.type === "text") as TextPart | undefined
          if (toolPart) preview = `[tool: ${toolPart.tool}]`
          else if (textPart) preview = textPart.text?.replace(/\n/g, " ")?.slice(0, 60) ?? ""
          else preview = "[response]"
        }

        const isLeaf = msg.id === props.leafID
        const hasBranches = (childrenMap.get(msg.id)?.length ?? 0) > 1

        result.push({
          title: `${indent}${onCurrentBranch}${role}: ${preview}${isLeaf ? " ← current" : ""}${hasBranches ? " ⑂" : ""}`,
          value: msg.id,
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
              props.onBranch(msg.id)
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

  return <DialogSelect title="Session Tree" options={options()} />
}
