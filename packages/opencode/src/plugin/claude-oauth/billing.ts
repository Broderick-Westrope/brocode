// Billing header injected as a system message entry (not an HTTP header).
// The cch field is intentionally derived from system prompt text rather than
// user message text — the system.transform hook doesn't have access to
// messages, so we use the system prompt as the hash input instead.

function sha256(input: string) {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

export function compute(text: string, version: string, entrypoint: string): string {
  const cch = sha256(text).slice(0, 5)
  const sampled = [text[4] ?? "0", text[7] ?? "0", text[20] ?? "0"].join("")
  const suffix = sha256("59cf53e54c78" + sampled + version).slice(0, 3)
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`
}
