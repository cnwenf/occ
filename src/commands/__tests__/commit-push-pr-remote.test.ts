import { describe, expect, test } from 'bun:test'
import '../../commands.js'
import { getPromptContent } from '../commit-push-pr.js'

/**
 * claude-code 2.1.206 #3: `/commit-push-pr` should auto-allow `git push` to
 * the repo's `pushDefault`/sole remote, not just `origin`. The official binary
 * updated the prompt instruction from "Push the branch to origin" to
 * "Push the branch to the repo's remote (usually `origin`; use the remote
 * this repo is actually configured with)". OCC's ALLOWED_TOOLS already permits
 * `Bash(git push:*)` to any remote, so the faithful minimal fix is the prompt
 * text change — the model discovers the right remote at runtime.
 */
describe('2.1.206 #3 /commit-push-pr push to configured remote', () => {
  test('prompt instructs pushing to the repo remote, not hardcoded origin', () => {
    const prompt = getPromptContent('main')
    expect(prompt).toContain(
      "Push the branch to the repo's remote (usually `origin`; use the remote this repo is actually configured with)",
    )
  })

  test('prompt does not use the old hardcoded "to origin" wording', () => {
    const prompt = getPromptContent('main')
    // The old wording "Push the branch to origin" must not appear verbatim
    // as a standalone step (the new wording embeds `origin` as an example).
    expect(prompt).not.toMatch(/Push the branch to origin\b/)
  })

  test('ALLOWED_TOOLS still permits git push to any remote', () => {
    const mod = require('../commit-push-pr.js') as {
      default: { allowedTools: string[] }
    }
    expect(mod.default.allowedTools).toContain('Bash(git push:*)')
  })
})
