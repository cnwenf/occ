import { feature } from 'src/utils/featureFlags.js'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getGitStatus, getSystemContext, getUserContext } from '../../context.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage.js'
import { clearBetaTracingState } from '../../utils/telemetry/betaSessionTracing.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * Run cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact to free memory
 * held by tracking structures that are invalidated by compaction.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so we can skip
 * resets that would clobber main-thread module-level state. Subagents
 * (agent:*) run in the same process and share module-level state
 * (context-collapse store, getMemoryFiles one-shot hook flag,
 * getUserContext cache); resetting those when a SUBAGENT compacts
 * would corrupt the MAIN thread's state. All compaction callers should
 * pass querySource — undefined is only safe for callers that are
 * genuinely main-thread-only (/compact, /clear).
 */
export function runPostCompactCleanup(querySource?: QuerySource): void {
  // Subagents (agent:*) run in the same process and share module-level
  // state with the main thread. Only reset main-thread module-level state
  // (context-collapse, memory file cache) for main-thread compacts.
  // Same startsWith pattern as isMainThread (index.ts:188).
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
      ).resetContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  if (isMainThreadCompact) {
    // getUserContext is a memoized outer layer wrapping getClaudeMds() →
    // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
    // the next turn hits the getUserContext cache and never reaches
    // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
    // Manual /compact already clears this explicitly at its call sites;
    // auto-compact and reactive-compact did not — this centralizes the
    // clear so all compaction paths behave consistently.
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
    // Official 2.1.269 (E15): the v269 refresh builder (binary `GXn`) drops
    // the previously announced gitStatus and re-computes a fresh snapshot on
    // every main-thread context refresh (compact): binary
    // `let{gitStatus:d,...m}=n.announced; ... E=await(_??ADe())??void 0;
    // return{...n,announced:{...m,gitStatus:E}}`. OCC's equivalents are the
    // memoized getSystemContext (outer) and getGitStatus (inner) layers —
    // clearing only the outer would still replay the stale inner snapshot,
    // so both are cleared. The official's take-once latency prefetch
    // (`gitStatusPrefetch`/`Tyn`) is not ported — it only shaves await
    // latency off the same recomputation, no behavioral delta. The
    // CLAUDE_CODE_REMOTE / git-instructions gates live inside
    // getSystemContext, so the rebuild re-evaluates them unchanged.
    getSystemContext.cache.clear?.()
    getGitStatus.cache.clear?.()
  }
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(m =>
      m.sweepFileContentCache(),
    )
  }
  clearSessionMessagesCache()
}
