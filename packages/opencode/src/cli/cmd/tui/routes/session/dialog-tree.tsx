import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { Keybind } from "@/util/keybind"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { useKeyboard } from "@opentui/solid"
import { DialogPrompt } from "@tui/ui/dialog-prompt"

export function DialogTree(props: {
  sessionID: string
  leafID?: string
  onBranch: (messageID: string, prompt?: PromptInfo) => void
  onDelete?: (messageID: string) => Promise<void>
  onLabel?: (messageID: string, label: string | undefined) => Promise<void>
}) {
  const sync = useSync()
  const dialog = useDialog()
  const [collapsed, setCollapsed] = createSignal(new Set<string>())
  let selectRef: DialogSelectRef<string> | undefined

  onMount(() => {
    dialog.setSize("large")
  })

  useKeyboard((evt) => {
    // Don't process character keybinds while filtering
    if (selectRef?.filterActive) return

    // Character keybinds (d, l) are handled here instead of via DialogSelect's
    // keybind prop because focused inputs consume character keys before the
    // keybind matching in DialogSelect's useKeyboard fires.
    const sel = selectRef?.selected
    if (!sel) return

    if (evt.name === "l" && props.onLabel) {
      evt.preventDefault()
      evt.stopPropagation()
      const data = computed()
      const msgID = data.optionToMsg.get(sel.value)
      if (!msgID) return
      const currentLabel = data.msgMap.get(msgID)?.label ?? ""
      // Use dialog.replace to show the label prompt — <Show> switching
      // inside an existing dialog doesn't trigger visual updates in opentui.
      DialogPrompt.show(dialog, "Set Message Label", {
        value: currentLabel,
        placeholder: "Enter label (empty to clear)",
      }).then((value) => {
        if (value !== null) {
          props.onLabel!(msgID, value.trim() || undefined)
        }
      })
      return
    }

    if (evt.name === "d" && props.onDelete) {
      evt.preventDefault()
      evt.stopPropagation()
      const data = computed()
      const msgID = data.optionToMsg.get(sel.value)
      if (!msgID) return
      if (data.ancestorSet.has(msgID)) return
      let count = 0
      const queue = [...(data.childrenMap.get(msgID) ?? [])]
      while (queue.length > 0) {
        const child = queue.pop()!
        if (data.ancestorSet.has(child.id)) return
        count++
        queue.push(...(data.childrenMap.get(child.id) ?? []))
      }
      const prompt = count > 0
        ? `Delete this message and ${count} descendants?`
        : "Delete this message?"
      DialogPrompt.show(dialog, prompt, {
        value: "y",
        placeholder: "y to confirm, anything else to cancel",
      }).then((value) => {
        if (value === "y") {
          props.onDelete!(msgID)
        }
      })
      return
    }
  })

  const computed = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    if (!messages.length) return { result: [], optionToMsg: new Map<string, string>(), childrenMap: new Map<string | null, typeof messages>(), msgMap: new Map<string, typeof messages[0]>(), ancestorSet: new Set<string>() }

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
    const optionToMsg = new Map<string, string>()

    function walk(parentID: string | null, depth: number) {
      const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => b.time.created - a.time.created)
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
        const visibleChildren = (childrenMap.get(msg.id) ?? []).filter((c) => {
          const p = c.treeParentID ? msgMap.get(c.treeParentID) : undefined
          return !(c.role === "assistant" && p?.role === "assistant")
        })
        const hasVisibleChildren = visibleChildren.length > 0
        const collapseIndicator = hasVisibleChildren
          ? collapsed().has(msg.id) ? "▸ " : "▾ "
          : "  "

        const optionValue = tail?.id ?? msg.id
        optionToMsg.set(optionValue, msg.id)

        const labelPrefix = msg.label ? `[${msg.label}] ` : ""
        result.push({
          title: `${indent}${branchMarker}${collapseIndicator}${role}: ${labelPrefix}${preview}${isLeaf ? " ← current" : ""}`,
          value: optionValue,
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

        if (!collapsed().has(msg.id)) {
          walk(msg.id, depth + 1)
        }
      }
    }

    walk(null, 0)
    return { result, optionToMsg, childrenMap, msgMap, ancestorSet }
  })

  const options = createMemo(() => computed().result)

  return (
    <DialogSelect
      title="Session Tree"
      options={options()}
      filterMode="on-demand"
      placeholder="/ to filter · Enter to select · Esc to cancel"
      ref={(r) => { selectRef = r }}
      keybind={[
        {
          keybind: Keybind.parse("left")[0],
          title: "Collapse",
          onTrigger: (option) => {
            const data = computed()
            const msgID = data.optionToMsg.get(option.value)
            if (!msgID) return
            const hasChildren = (data.childrenMap.get(msgID) ?? []).some((c) => {
              const p = c.treeParentID ? data.msgMap.get(c.treeParentID) : undefined
              return !(c.role === "assistant" && p?.role === "assistant")
            })
            if (!collapsed().has(msgID) && hasChildren) {
              setCollapsed((prev) => { const next = new Set(prev); next.add(msgID); return next })
              return
            }
            // Already collapsed or leaf → navigate to parent.
            // Walk up treeParentID chain to find the nearest ancestor
            // that has an option in the tree (skips continuation assistants).
            let parentID = data.msgMap.get(msgID)?.treeParentID
            while (parentID) {
              const parentOptIdx = options().findIndex((o) => data.optionToMsg.get(o.value) === parentID)
              if (parentOptIdx >= 0 && selectRef) {
                selectRef.moveTo(parentOptIdx)
                return
              }
              parentID = data.msgMap.get(parentID)?.treeParentID
            }
          },
        },
        {
          keybind: Keybind.parse("right")[0],
          title: "Expand",
          onTrigger: (option) => {
            const msgID = computed().optionToMsg.get(option.value)
            if (!msgID) return
            if (collapsed().has(msgID)) {
              setCollapsed((prev) => { const next = new Set(prev); next.delete(msgID); return next })
            }
          },
        },
        // l and d are handled in DialogTree's useKeyboard because focused
        // inputs consume character keys before DialogSelect's keybind matching.
        // These entries exist for footer hint display only.
        ...(props.onLabel ? [{
          keybind: Keybind.parse("l")[0],
          title: "Label",
          side: "right" as const,
          onTrigger: () => {},
        }] : []),
        ...(props.onDelete ? [{
          keybind: Keybind.parse("d")[0],
          title: "Delete",
          side: "right" as const,
          onTrigger: () => {},
        }] : []),
      ]}
    />
  )
}
