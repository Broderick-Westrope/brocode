import { Effect, Layer, Context } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { SessionID, MessageID } from "./schema"
import { MessageV2 } from "./message-v2"
import { LLM } from "./llm"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "branch-summary" })

const PROMPT =
  "Summarise what was attempted on this branch and the outcome in 2-3 sentences. Focus on: what was tried, what worked, what didn't, and why the branch was abandoned."

export interface Interface {
  readonly generate: (input: {
    sessionID: SessionID
    fromLeafID: MessageID
    toAncestorID: MessageID
    model?: { id: string; providerID: string }
  }) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BranchSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service

    const generate = Effect.fn(
      "BranchSummary.generate",
    )(
      function* (input: {
        sessionID: SessionID
        fromLeafID: MessageID
        toAncestorID: MessageID
        model?: { id: string; providerID: string }
      }) {
        const ancestorPath = MessageV2.getAncestorPath(input.sessionID, input.fromLeafID)
        const ancestorIdx = ancestorPath.indexOf(input.toAncestorID)
        if (ancestorIdx < 0) return undefined

        const branchSlice = ancestorPath.slice(ancestorIdx + 1)
        if (branchSlice.length === 0) return undefined

        const branchMessages = branchSlice.map((id) => MessageV2.get({ sessionID: input.sessionID, messageID: id }))

        const lastUserMsg = [...branchMessages]
          .reverse()
          .find((m): m is MessageV2.WithParts & { info: MessageV2.User } => m.info.role === "user")

        const cfg = yield* config.get()

        const resolvedProviderID =
          input.model?.providerID ??
          (cfg.summarisation_model ? cfg.summarisation_model.split("/")[0] : undefined) ??
          lastUserMsg?.info.model.providerID
        const resolvedModelID =
          input.model?.id ??
          (cfg.summarisation_model ? cfg.summarisation_model.split("/").slice(1).join("/") : undefined) ??
          lastUserMsg?.info.model.modelID

        if (!resolvedProviderID || !resolvedModelID) return undefined

        const model = yield* provider
          .getModel(ProviderID.make(resolvedProviderID), ModelID.make(resolvedModelID))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return undefined

        const agent = yield* agents.get("compaction")
        const modelMessages = yield* MessageV2.toModelMessagesEffect(branchMessages, model, { stripMedia: true })

        const syntheticUser: MessageV2.User = {
          id: MessageID.ascending(),
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "compaction",
          model: { providerID: ProviderID.make(resolvedProviderID), modelID: ModelID.make(resolvedModelID) },
        }

        let text = ""
        yield* llm
          .stream({
            user: syntheticUser,
            sessionID: input.sessionID,
            model,
            agent,
            system: [],
            messages: [
              ...modelMessages,
              { role: "user" as const, content: [{ type: "text" as const, text: PROMPT }] },
            ],
            tools: {},
          })
          .pipe(
            Stream.tap((event) => {
              if (event.type === "text-delta" && "text" in event && typeof event.text === "string") text += event.text
              return Effect.void
            }),
            Stream.runDrain,
            Effect.catch((e) => {
              log.warn("branch summary stream failed", { error: String(e) })
              return Effect.succeed(undefined)
            }),
          )

        return text.trim() || undefined
      },
      Effect.catch((e) => {
        log.warn("branch summary generation failed", { error: String(e) })
        return Effect.succeed(undefined)
      }),
    )

    return Service.of({ generate })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as BranchSummary from "./branch-summary"
