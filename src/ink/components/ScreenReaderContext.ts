/**
 * Screen-reader context (binary: `P2n`). Provided by the Ink renderer into the
 * component tree so components can render SR-friendly variants. The value is
 * `isScreenReaderEnabled` (boolean) — true when the SR flat-render path is
 * active.
 *
 * Wired into the render tree in src/ink/ink.tsx alongside TerminalWriteProvider.
 */
import { createContext, useContext } from 'react'

export const ScreenReaderContext = createContext<boolean>(false)

export function useIsScreenReader(): boolean {
  return useContext(ScreenReaderContext)
}
