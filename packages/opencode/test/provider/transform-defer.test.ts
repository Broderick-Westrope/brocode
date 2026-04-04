import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../../src/provider/transform"

describe("ProviderTransform.supportsDefer()", () => {
  const model = (npm: string, id: string) =>
    ({ api: { npm, id } }) as Parameters<typeof ProviderTransform.supportsDefer>[0]

  test("supports claude-sonnet-4-20250514", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-sonnet-4-20250514"))).toBe(true)
  })

  test("supports claude-opus-4-20250514", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-opus-4-20250514"))).toBe(true)
  })

  test("supports claude-opus-4.1", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-opus-4.1"))).toBe(true)
  })

  test("supports claude-opus-4-1", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-opus-4-1"))).toBe(true)
  })

  test("supports claude-sonnet-4.6", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-sonnet-4.6"))).toBe(true)
  })

  test("supports future versions", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-sonnet-5-20260101"))).toBe(true)
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-opus-12-20280101"))).toBe(true)
  })

  test("rejects haiku", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-haiku-4-20250514"))).toBe(false)
  })

  test("rejects non-anthropic provider", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/openai", "claude-sonnet-4-20250514"))).toBe(false)
  })

  test("rejects older models", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-3-5-sonnet-20241022"))).toBe(false)
  })

  test("rejects version below 4", () => {
    expect(ProviderTransform.supportsDefer(model("@ai-sdk/anthropic", "claude-sonnet-3-20240101"))).toBe(false)
  })
})
