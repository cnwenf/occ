// 2.1.216 #19 — MCP re-authenticate must not revoke working credentials
// before the new sign-in succeeds.
//
// Previously, `MCPRemoteServerMenu.handleAuthenticate` called
// `revokeServerTokens` (server-side RFC 7009 revocation, irreversible +
// local clear) BEFORE `performMCPOAuthFlow`. If the new sign-in failed,
// was cancelled, or timed out, the user's previously-working credentials
// were already destroyed — leaving them credentialless with no way to
// recover except a full re-auth from scratch.
//
// The fix: complete the new sign-in FIRST, then revoke old tokens only
// after it succeeds. This test verifies the ordering invariant.
//
// The bg-session "needs-auth message pointing at an unusable command"
// half of #19 does NOT apply to OCC — OCC's background reconnect path
// emits a generic `Server status: needs-auth` that doesn't reference
// `/mcp` or any interactive command (the `/mcp` hint is explicitly
// suppressed in remote/background mode via `useMcpConnectivityStatus`).

import { describe, expect, test } from 'bun:test'
import { reauthenticateWithSafeOrdering } from '../reauthOrdering.js'

describe('2.1.216 #19 — MCP re-auth revoke ordering', () => {
  test('performNewSignIn runs BEFORE revokeOldTokens on success', async () => {
    const callOrder: string[] = []

    await reauthenticateWithSafeOrdering({
      wasAuthenticated: true,
      performNewSignIn: async () => {
        callOrder.push('signIn')
      },
      revokeOldTokens: async () => {
        callOrder.push('revoke')
      },
    })

    expect(callOrder).toEqual(['signIn', 'revoke'])
  })

  test('revokeOldTokens is NOT called when performNewSignIn throws', async () => {
    const callOrder: string[] = []

    await expect(
      reauthenticateWithSafeOrdering({
        wasAuthenticated: true,
        performNewSignIn: async () => {
          callOrder.push('signIn')
          throw new Error('OAuth flow cancelled')
        },
        revokeOldTokens: async () => {
          callOrder.push('revoke')
        },
      }),
    ).rejects.toThrow('OAuth flow cancelled')

    // Old tokens must remain intact — revoke was never called.
    expect(callOrder).toEqual(['signIn'])
    expect(callOrder).not.toContain('revoke')
  })

  test('revokeOldTokens is NOT called when wasAuthenticated is false', async () => {
    const callOrder: string[] = []

    await reauthenticateWithSafeOrdering({
      wasAuthenticated: false,
      performNewSignIn: async () => {
        callOrder.push('signIn')
      },
      revokeOldTokens: async () => {
        callOrder.push('revoke')
      },
    })

    // First-time auth (no existing tokens to revoke).
    expect(callOrder).toEqual(['signIn'])
  })

  test('revokeOldTokens is NOT called when performNewSignIn throws even if wasAuthenticated', async () => {
    // This is the critical regression: previously working credentials
    // must survive a failed re-auth attempt.
    let revokeCalled = false

    await expect(
      reauthenticateWithSafeOrdering({
        wasAuthenticated: true,
        performNewSignIn: async () => {
          throw new Error('timeout')
        },
        revokeOldTokens: async () => {
          revokeCalled = true
        },
      }),
    ).rejects.toThrow('timeout')

    expect(revokeCalled).toBe(false)
  })

  test('revokeOldTokens IS called after a successful re-auth of an already-authenticated server', async () => {
    let revokeCalled = false

    await reauthenticateWithSafeOrdering({
      wasAuthenticated: true,
      performNewSignIn: async () => {},
      revokeOldTokens: async () => {
        revokeCalled = true
      },
    })

    expect(revokeCalled).toBe(true)
  })
})
