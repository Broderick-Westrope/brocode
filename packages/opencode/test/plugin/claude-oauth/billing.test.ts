import { describe, expect, test } from "bun:test"
import { compute } from "../../../src/plugin/claude-oauth/billing"

describe("billing.compute()", () => {
  test("returns billing header string", () => {
    const result = compute("test text", "2.1.90", "cli")
    expect(result.startsWith("x-anthropic-billing-header:")).toBe(true)
  })

  test("contains structural keys", () => {
    const result = compute("test text", "2.1.90", "cli")
    expect(result).toContain("cc_version=")
    expect(result).toContain("cc_entrypoint=")
    expect(result).toContain("cch=")
  })

  test("deterministic for same inputs", () => {
    const text = "test text"
    const version = "2.1.90"
    const entrypoint = "cli"
    const result1 = compute(text, version, entrypoint)
    const result2 = compute(text, version, entrypoint)
    expect(result1).toBe(result2)
  })

  test("varies with different text", () => {
    const version = "2.1.90"
    const entrypoint = "cli"
    const result1 = compute("text one", version, entrypoint)
    const result2 = compute("text two", version, entrypoint)
    expect(result1).not.toBe(result2)
  })

  test("handles empty string", () => {
    const result = compute("", "2.1.90", "cli")
    expect(result.startsWith("x-anthropic-billing-header:")).toBe(true)
    expect(result).toContain("cch=")
  })

  test("handles short string", () => {
    // String shorter than 21 chars - some indices fall back to "0"
    const result = compute("short", "2.1.90", "cli")
    expect(result.startsWith("x-anthropic-billing-header:")).toBe(true)
    expect(result).toContain("cch=")
  })

  test("handles long string", () => {
    // String longer than 21 chars - all indices hit real characters
    const result = compute("this is a longer text string", "2.1.90", "cli")
    expect(result.startsWith("x-anthropic-billing-header:")).toBe(true)
    expect(result).toContain("cch=")
  })
})
