// 2.1.203: persistent footer banner + transient high-priority notification
// warning that the user's OAuth login (refresh token) is about to expire, so
// they can re-authenticate before background sessions are interrupted.
//
// Faithful port of the official surfaces (decompiled from the 2.1.204 binary):
//   - `OXd`: a persistent warning banner rendered while `slr()` returns
//     non-null (login within the 5-day warn window).
//   - `oauth-expiry-warning`: a transient notification (priority "high",
//     timeout 15s) fired only when `daysLeft <= 1`.
// Both render: "Your login expires in {n} {day/days} · run /login to renew".

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useNotifications } from '../../context/notifications.js'
import { Box, Text } from '../../ink.js'
import {
  getOAuthLoginExpiryInfo,
  pluralize,
} from '../../utils/oauthLoginExpiry.js'

/** Re-evaluate the expiry countdown this often (the value only changes daily). */
const REEVALUATE_INTERVAL_MS = 60_000

export function OAuthExpiryNotice() {
  const { addNotification } = useNotifications()
  // Force a periodic re-evaluation so the countdown and a freshly-near expiry
  // are reflected without waiting for an unrelated re-render.
  const [, forceRender] = useState(0)
  const notifiedRef = useRef(false)

  useEffect(() => {
    const id = setInterval(
      () => forceRender(n => (n + 1) % 1_000_000),
      REEVALUATE_INTERVAL_MS,
    )
    return () => clearInterval(id)
  }, [])

  // Read during render — getClaudeAIOAuthTokens is memoized, so this is O(1)
  // after the first call (mirrors the official OXd calling slr() on render).
  // Defensive: any pre-config/secure-storage hiccup must never blank the footer.
  let info: ReturnType<typeof getOAuthLoginExpiryInfo> = null
  try {
    info = getOAuthLoginExpiryInfo()
  } catch {
    info = null
  }

  // Fire the high-priority transient notification once per near-expiry window.
  useEffect(() => {
    if (info && info.daysLeft <= 1 && !notifiedRef.current) {
      notifiedRef.current = true
      addNotification({
        key: 'oauth-expiry-warning',
        priority: 'high',
        timeoutMs: 15_000,
        jsx: (
          <Text color="warning" wrap="truncate">
            Your login expires in {info.daysLeft}{' '}
            {pluralize(info.daysLeft, 'day')}
            <Text dimColor wrap="truncate">
              {' · run /login to renew'}
            </Text>
          </Text>
        ),
      })
    } else if (!info) {
      // Login no longer near expiry (refreshed/re-logged in): allow re-firing.
      notifiedRef.current = false
    }
  }, [info?.daysLeft, addNotification])

  if (!info) return null

  // Persistent banner — visible for the whole warn window (up to 5 days).
  return (
    <Box>
      <Text color="warning" wrap="truncate">
        Your login expires in {info.daysLeft} {pluralize(info.daysLeft, 'day')}
      </Text>
      <Text dimColor wrap="truncate">
        {' · run /login to renew'}
      </Text>
    </Box>
  )
}
