/**
 * The compact-summary header line (OCC's equivalent of the official `eXe`
 * header constant). Extracted into its own module so BOTH the composer
 * (prompt.ts) and the tool-names tag machinery (toolNamesUsed.ts, whose
 * `Xan`-equivalent regex anchors on this exact line) can import it without a
 * circular dependency between those two modules.
 *
 * CC 2.1.304 #6: the official tag-match regex `Xan` (@247678676) is built as
 * `^(${Van}${Ma(eXe)}\n\n${Van})<tools-used-before-summary>([^<]*)</…>\n?` —
 * i.e. anchored on the header followed by a blank line. OCC keeps its own
 * header prose (documented divergence — the official `eXe`/`Uy(foreignArtifact)`
 * strings were not byte-recovered), so the anchor adapts to THIS line.
 */
export const COMPACT_SUMMARY_HEADER =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'
