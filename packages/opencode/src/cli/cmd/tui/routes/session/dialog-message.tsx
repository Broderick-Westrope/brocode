import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import * as Clipboard from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  onBranch?: (messageID: string, prompt?: PromptInfo) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))

  function getPromptInfo(): PromptInfo | undefined {
    const msg = message()
    if (!msg) return undefined
    const parts = sync.data.part[msg.id] ?? []
    return parts.reduce(
      (agg, part) => {
        if (part.type === "text" && !part.synthetic) agg.input += part.text
        if (part.type === "file") agg.parts.push(strip(part))
        return agg
      },
      { input: "", parts: [] as PromptInfo["parts"] },
    )
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Branch from here",
          value: "session.branch",
          description: "start a new branch from this message",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return
            props.onBranch?.(msg.treeParentID ?? msg.id, getPromptInfo())
            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id] ?? []
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
      ]}
    />
  )
}
