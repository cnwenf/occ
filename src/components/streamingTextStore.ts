type Listener = () => void

/**
 * Module-level store for the live streaming-assistant text.
 *
 * Why a store (not React state in REPL): the streaming text updates on every
 * token. When it lived in REPL as useState, each token re-rendered the ENTIRE
 * REPL (prompt input, footer, the whole message list) — "the whole screen
 * re-rendered while a long response streamed" (2.1.203). Moving it behind an
 * external store lets only the <StreamingPreview> leaf (which subscribes via
 * useSyncExternalStore) re-render per token; the rest of the tree is untouched.
 *
 * Single active stream is assumed (one REPL). The store is reset to null on
 * query end / interrupt.
 */
let currentText: string | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l()
}

export const streamingTextStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** Snapshot for useSyncExternalStore — stable reference equality per value. */
  getSnapshot(): string | null {
    return currentText
  },
  /** Imperative read (e.g. the interrupt marker in REPL reads the latest text
   * outside of React's render cycle). */
  get(): string | null {
    return currentText
  },
  set(next: string | null): void {
    if (next === currentText) return
    currentText = next
    emit()
  },
  clear(): void {
    if (currentText === null) return
    currentText = null
    emit()
  },
}
