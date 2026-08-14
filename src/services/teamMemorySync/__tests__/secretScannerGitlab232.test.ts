import { describe, expect, test } from 'bun:test'
import {
  getSecretLabel,
  redactSecrets,
  scanForSecrets,
} from '../secretScanner.js'

/**
 * 2.1.232 alignment — the official team-memory scrubber consolidated all
 * routable GitLab token families onto one shared body shape
 * (`gl<Prefix>-[\\w=-]{20,}` + optional `.xxxxxxxxx` rotation suffix,
 * binary constant X1e) and added 9 new prefixes on top of the previous
 * `glpat-` / `gldt-` pair. These tests pin the OCC port of that family.
 */

// 20 chars from [\w=-] — the minimum body length.
const MIN_BODY = 'abcdefghijklmnopqrst'
// Longer body + 9-char lowercase rotation suffix (the optional part).
const SUFFIXED_BODY = 'A1B2c3D4e5F6_g7H8i9J0k=abcdefghijklmnopqrst.a1b2c3d4e'

const GITLAB_FAMILIES = [
  { prefix: 'glpat', ruleId: 'gitlab-pat' },
  { prefix: 'gldt', ruleId: 'gitlab-deploy-token' },
  { prefix: 'glrt', ruleId: 'gitlab-runner-authentication-token' },
  { prefix: 'gloas', ruleId: 'gitlab-oauth-app-secret' },
  { prefix: 'glptt', ruleId: 'gitlab-pipeline-trigger-token' },
  { prefix: 'glagent', ruleId: 'gitlab-kubernetes-agent-token' },
  { prefix: 'glimt', ruleId: 'gitlab-incoming-mail-token' },
  { prefix: 'glsoat', ruleId: 'gitlab-scim-oauth-token' },
  { prefix: 'glcbt', ruleId: 'gitlab-ci-build-token' },
  { prefix: 'glft', ruleId: 'gitlab-feed-token' },
  { prefix: 'glffct', ruleId: 'gitlab-feature-flag-client-token' },
] as const

describe('2.1.232 — GitLab token family detection', () => {
  test.each(GITLAB_FAMILIES)(
    'detects $prefix- tokens as $ruleId',
    ({ prefix, ruleId }) => {
      // Arrange
      const content = `token = "${prefix}-${MIN_BODY}"`

      // Act
      const matches = scanForSecrets(content)

      // Assert
      expect(matches.map(m => m.ruleId)).toContain(ruleId)
    },
  )

  test('accepts the rotation suffix form (body.9-lowercase-chars)', () => {
    // Arrange
    const content = `GITLAB_TOKEN=glpat-${SUFFIXED_BODY}`

    // Act
    const matches = scanForSecrets(content)

    // Assert
    expect(matches.map(m => m.ruleId)).toContain('gitlab-pat')
  })

  test('rejects bodies shorter than 20 chars', () => {
    // Arrange
    const content = `glpat-${MIN_BODY.slice(0, 19)}`

    // Act
    const matches = scanForSecrets(content)

    // Assert
    expect(matches.map(m => m.ruleId)).not.toContain('gitlab-pat')
  })

  test('labels CI and SCIM families with uppercase acronyms', () => {
    expect(getSecretLabel('gitlab-ci-build-token')).toBe(
      'GitLab CI Build Token',
    )
    expect(getSecretLabel('gitlab-scim-oauth-token')).toBe(
      'GitLab SCIM OAuth Token',
    )
    expect(getSecretLabel('gitlab-runner-authentication-token')).toBe(
      'GitLab Runner Authentication Token',
    )
  })

  test('redactSecrets replaces gitlab tokens in place', () => {
    // Arrange
    const token = `glrt-${MIN_BODY}`
    const content = `runner auth: ${token} end`

    // Act
    const redacted = redactSecrets(content)

    // Assert
    expect(redacted).not.toContain(token)
    expect(redacted).toContain('[REDACTED]')
    expect(redacted).toContain('runner auth: ')
  })
})
