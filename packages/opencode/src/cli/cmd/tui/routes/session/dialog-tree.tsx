import { createMemo, createSignal, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "@tui/ui/dialog-select"
import type { TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { useKeyboard } from "@opentui/solid"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useTheme } from "@tui/context/theme"

export function DialogTree(props: {
  sessionID: string
  leafID?: string
  onBranch: (messageID: string | undefined, prompt?: PromptInfo) => void
  onDelete?: (messageID: string) => Promise<void>
  onLabel?: (messageID: string, label: string | undefined) => Promise<void>
}) {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [collapsed, setCollapsed] = createSignal(new Set<string>())
  const [selectedValue, setSelectedValue] = createSignal<string | undefined>()
  const [filterQuery, setFilterQuery] = createSignal("")
  let selectRef: DialogSelectRef<string> | undefined

  onMount(() => {
    dialog.setSize("large")
  })

  // Re-open the tree dialog after a sub-dialog (label/delete) completes.
  // Creates a fresh DialogTree instance but preserves session context.
  function reopenTree() {
    dialog.replace(() => (
      <DialogTree
        sessionID={props.sessionID}
        leafID={props.leafID}
        onBranch={props.onBranch}
        onDelete={props.onDelete}
        onLabel={props.onLabel}
      />
    ))
  }

  // Check if a subtree rooted at msgID overlaps the current branch
  function canDelete(msgID: string): boolean {
    const data = computed()
    if (data.ancestorSet.has(msgID)) return false
    const queue = [...(data.childrenMap.get(msgID) ?? [])]
    while (queue.length > 0) {
      const child = queue.pop()!
      if (data.ancestorSet.has(child.id)) return false
      queue.push(...(data.childrenMap.get(child.id) ?? []))
    }
    return true
  }

  useKeyboard((evt) => {
    // Don't process keybinds while filtering
    if (selectRef?.filterActive) return

    const sel = selectRef?.selected
    if (!sel) return

    if (evt.name === "left") {
      evt.preventDefault()
      evt.stopPropagation()
      const data = computed()
      const msgID = data.optionToMsg.get(sel.value)
      if (!msgID) return
      const hasChildren = (data.childrenMap.get(msgID) ?? []).some((c) => {
        const p = c.treeParentID ? data.msgMap.get(c.treeParentID) : undefined
        return !(c.role === "assistant" && p?.role === "assistant")
      })
      if (!collapsed().has(msgID) && hasChildren) {
        setCollapsed((prev) => { const next = new Set(prev); next.add(msgID); return next })
        return
      }
      let parentID = data.msgMap.get(msgID)?.treeParentID
      while (parentID) {
        const parentOptIdx = options().findIndex((o) => data.optionToMsg.get(o.value) === parentID)
        if (parentOptIdx >= 0 && selectRef) {
          selectRef.moveTo(parentOptIdx)
          return
        }
        parentID = data.msgMap.get(parentID)?.treeParentID
      }
      return
    }

    if (evt.name === "right") {
      evt.preventDefault()
      evt.stopPropagation()
      const msgID = computed().optionToMsg.get(sel.value)
      if (!msgID) return
      if (collapsed().has(msgID)) {
        setCollapsed((prev) => { const next = new Set(prev); next.delete(msgID); return next })
      }
      return
    }

    if (evt.name === "l" && props.onLabel) {
      evt.preventDefault()
      evt.stopPropagation()
      const data = computed()
      const msgID = data.optionToMsg.get(sel.value)
      if (!msgID) return
      const currentLabel = data.msgMap.get(msgID)?.label ?? ""
      DialogPrompt.show(dialog, "Set Message Label", {
        value: currentLabel,
        placeholder: "Enter label (empty to clear)",
      }).then((value) => {
        if (value !== null) {
          props.onLabel!(msgID, value.trim() || undefined)
        }
        reopenTree()
      })
      return
    }

    if (evt.name === "d" && props.onDelete) {
      evt.preventDefault()
      evt.stopPropagation()
      const data = computed()
      const msgID = data.optionToMsg.get(sel.value)
      if (!msgID) return
      if (!canDelete(msgID)) return
      let count = 0
      const queue = [...(data.childrenMap.get(msgID) ?? [])]
      while (queue.length > 0) {
        const child = queue.pop()!
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
        reopenTree()
      })
      return
    }
  })

  const computed = createMemo(() => {
    const messages = sync.data.message[props.sessionID] ?? []
    if (!messages.length) return { result: [], filterTitles: new Map<string, string>(), optionToMsg: new Map<string, string>(), childrenMap: new Map<string | null, typeof messages>(), msgMap: new Map<string, typeof messages[0]>(), ancestorSet: new Set<string>() }

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
    const compactedSet = new Set<string>()
    if (ancestorSet.size > 0) {
      const ancestorList = [...ancestorSet]
      for (const id of ancestorList) {
        const msg = msgMap.get(id)
        if (msg?.role !== "user") continue
        const parts = sync.data.part[msg.id] ?? []
        const compactionPart = parts.find((p) => p.type === "compaction" && p.tail_start_id) as
          | { type: "compaction"; tail_start_id: string }
          | undefined
        if (!compactionPart) continue
        const childMsgs = childrenMap.get(msg.id) ?? []
        const summaryAssistant = childMsgs.find(
          (m) => m.role === "assistant" && m.summary && m.finish && !m.error,
        )
        if (!summaryAssistant) continue
        const tailID = compactionPart.tail_start_id
        let foundTail = false
        for (const ancestorID of ancestorList) {
          if (ancestorID === tailID) foundTail = true
          if (foundTail) break
          compactedSet.add(ancestorID)
        }
        break
      }
    }

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
    const filterTitles = new Map<string, string>()

    function walk(parentID: string | null, indent: number, justBranched: boolean, gutters: { position: number; show: boolean }[]) {
      const children = (childrenMap.get(parentID) ?? []).toSorted((a, b) => b.time.created - a.time.created)

      // When a non-assistant parent has multiple assistant children (broken
      // continuation chain), keep only the final one — earlier chunks add noise.
      const keepAssistantID = (() => {
        const parentRole = parentID ? msgMap.get(parentID)?.role : undefined
        if (parentRole === "assistant") return undefined
        const assistants = children.filter((c) => c.role === "assistant")
        if (assistants.length <= 1) return undefined
        return assistants.reduce((a, b) => (a.id > b.id ? a : b)).id
      })()

      // Determine visible siblings for branch-point detection
      const visibleSiblings = children.filter((msg) => {
        const parentMsg = msg.treeParentID ? msgMap.get(msg.treeParentID) : undefined
        if (msg.role === "assistant" && parentMsg?.role === "assistant") return false
        if (keepAssistantID && msg.role === "assistant" && msg.id !== keepAssistantID) return false
        return true
      })
      const parentBranches = visibleSiblings.length > 1

      let visibleIdx = 0
      for (const msg of children) {
        const parentMsg = msg.treeParentID ? msgMap.get(msg.treeParentID) : undefined
        if (msg.role === "assistant" && parentMsg?.role === "assistant") {
          walk(msg.id, indent, justBranched, gutters)
          continue
        }

        // Skip earlier assistant siblings; still walk their children for branches.
        if (keepAssistantID && msg.role === "assistant" && msg.id !== keepAssistantID) {
          walk(msg.id, indent, justBranched, gutters)
          continue
        }

        const isLastVisible = visibleIdx === visibleSiblings.length - 1
        const isCompacted = compactedSet.has(msg.id)
        const onActivePath = ancestorSet.has(msg.id)
        const tail = msg.role === "assistant" ? lastContinuation(msg.id) : undefined
        const isLeaf = tail ? tail.id === props.leafID || msg.id === props.leafID : msg.id === props.leafID

        // Check foldability
        const msgVisibleChildren = (childrenMap.get(msg.id) ?? []).filter((c) => {
          const p = c.treeParentID ? msgMap.get(c.treeParentID) : undefined
          return !(c.role === "assistant" && p?.role === "assistant")
        })
        const hasVisibleChildren = msgVisibleChildren.length > 0
        const isFolded = collapsed().has(msg.id)

        // Build prefix with gutters and connectors (3 chars per indent level)
        const totalChars = indent * 3
        const connectorLevel = parentBranches && indent > 0 ? indent - 1 : -1
        const prefixChars: string[] = []

        for (let c = 0; c < totalChars; c++) {
          const level = Math.floor(c / 3)
          const posInLevel = c % 3
          const gutter = gutters.find((g) => g.position === level)

          if (gutter) {
            prefixChars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ")
          } else if (level === connectorLevel) {
            if (posInLevel === 0) prefixChars.push(isLastVisible ? "└" : "├")
            else if (posInLevel === 1) prefixChars.push(isFolded ? "⊞" : hasVisibleChildren ? "⊟" : "─")
            else prefixChars.push(" ")
          } else {
            prefixChars.push(" ")
          }
        }

        const prefix = prefixChars.join("")
        const showsFoldInConnector = parentBranches && indent > 0
        const foldMarker = isFolded && !showsFoldInConnector ? "⊞ " : ""
        const pathMarker = isCompacted ? "○ " : onActivePath ? "• " : "  "
        const role = msg.role === "user" ? "user" : "assistant"

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
          preview = assistantPreview(tail ?? msg)
          if (preview === "[response]" && tail && tail.id !== msg.id) preview = assistantPreview(msg)
        }

        const optionValue = tail?.id ?? msg.id
        optionToMsg.set(optionValue, msg.id)

        const labelPrefix = msg.label ? `[${msg.label}] ` : ""
        const content = `${role}: ${labelPrefix}${preview}${isLeaf ? " ← current" : ""}`
        filterTitles.set(optionValue, `${pathMarker}${content}`)
        result.push({
          title: `${prefix}${foldMarker}${pathMarker}${content}`,
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
              props.onBranch(msg.treeParentID, prompt)
            } else {
              props.onBranch(tail?.id ?? msg.id)
            }
            dialog.clear()
          },
        })

        // Compute child indent and gutters
        const msgBranches = msgVisibleChildren.length > 1
        let childIndent: number
        if (msgBranches) childIndent = indent + 1
        else if (justBranched && indent > 0) childIndent = indent + 1
        else childIndent = indent

        const childGutters = parentBranches && indent > 0
          ? [...gutters, { position: Math.max(0, indent - 1), show: !isLastVisible }]
          : gutters

        if (!isFolded) {
          walk(msg.id, childIndent, msgBranches, childGutters)
        }

        visibleIdx++
      }
    }

    walk(null, 0, false, [])
    return { result, filterTitles, optionToMsg, childrenMap, msgMap, ancestorSet }
  })

  const options = createMemo(() => {
    const data = computed()
    if (filterQuery().length > 0) {
      return data.result.map((opt) => ({
        ...opt,
        title: data.filterTitles.get(opt.value) ?? opt.title,
      }))
    }
    return data.result
  })

  return (
    <DialogSelect
      title="Session Tree"
      options={options()}
      filterMode="on-demand"
      ref={(r) => { selectRef = r }}
      onFilter={setFilterQuery}
      onMove={(option) => setSelectedValue(option.value)}
      hints={
        <box flexDirection="row" gap={2}>
          <text>
            <span style={{ fg: theme.text }}><b>←/→</b> </span>
            <span style={{ fg: theme.textMuted }}>collapse/expand</span>
          </text>
          <text>
            <span style={{ fg: theme.text }}><b>l</b> </span>
            <span style={{ fg: theme.textMuted }}>label</span>
          </text>
          <text>
            <span style={{ fg: theme.text }}><b>d</b> </span>
            <span style={{ fg: theme.textMuted }}>delete</span>
          </text>
          <text>
            <span style={{ fg: theme.text }}><b>/</b> </span>
            <span style={{ fg: theme.textMuted }}>filter</span>
          </text>
        </box>
      }
    />
  )
}
