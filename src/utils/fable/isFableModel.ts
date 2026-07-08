/**
 * Detect whether a model identifier refers to the Fable 5 research preview.
 *
 * Fable 5's canonical first-party id is `claude-fable-5`. The codename
 * `claude-mythos-5` canonicalizes to `claude-fable-5` (see
 * `firstPartyNameToCanonical` in model.ts). Provider-specific ids embed the
 * same substring (e.g. bedrock `us.anthropic.claude-fable-5`, mantle
 * `anthropic.claude-fable-5`), so a substring check covers every provider.
 *
 * Used by the credits counter, consent gate, and status indicator to decide
 * whether the Fable 5 machinery applies to the active model.
 */
export function isFableModel(model: string | undefined | null): boolean {
  if (!model) return false
  return model.includes('claude-fable-5') || model.includes('claude-mythos-5')
}
