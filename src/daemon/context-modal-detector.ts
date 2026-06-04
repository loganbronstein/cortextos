/**
 * Detects the Claude Code "/compact" context-limit modal in raw PTY output.
 *
 * When a session exhausts its context window it freezes at a modal whose body
 * reads "Context limit reached · /compact or /clear to continue". While wedged
 * there the statusline stops writing context_status.json, so the daemon's
 * threshold path (which returns early on a stale/missing bridge file) goes blind
 * — the exact failure that wedged scribe ~5.5h on 2026-06-04. The fast-checker
 * uses this detector as a hard signal that acts directly on PTY output,
 * independent of the bridge file, and force-restarts the frozen session.
 *
 * The modal renders TWO ways in real PTY output (verified against
 * logs/scribe/stdout.log, 2026-06-04):
 *   1. Contiguous: "Context limit reached · /compact or /clear to continue"
 *   2. Cursor-fragmented: the TUI redraws the line word-by-word, separating each
 *      word with an ANSI cursor-move code, e.g.
 *      "Context\x1b[14Glimit\x1b[20Greached\x1b[28G·\x1b[30G/compact…".
 *
 * Matching the raw buffer directly catches form 1 but SILENTLY MISSES form 2.
 * Stripping escape sequences to empty fuses the words ("Contextlimitreached")
 * and also misses it. So we replace every CSI escape sequence with a SINGLE
 * SPACE and collapse whitespace — both render forms normalize to the same token
 * stream — then require BOTH halves of the modal ("Context limit reached" and
 * "/compact or /clear to continue") to co-occur within a short gap. The
 * co-occurrence requirement means a stray "/compact" or a lone "Context limit
 * reached" printed in normal agent prose cannot false-trigger a restart.
 *
 * The CSI matcher uses the spec-correct final-byte class [@-~] (0x40–0x7E), so
 * it strips any cursor-move command at any column number / terminal width — the
 * detector is generic, not pinned to one capture's exact escape codes.
 */
export function detectContextLimitModal(rawPtyOutput: string): boolean {
  if (!rawPtyOutput) return false;
  return /Context limit reached.{0,30}\/compact or \/clear to continue/i.test(normalizeCsi(rawPtyOutput));
}

/**
 * Detects whether the Claude Code TUI is showing an input-ready bottom bar — i.e.
 * the session can accept input and is therefore NOT wedged. Used by the fast-checker
 * as a false-positive guard: an agent that merely *quoted* the /compact modal in its
 * output and then went idle still renders this bar, so we must NOT force-restart it.
 *
 * Marker selection is grounded in real 2026-06-04 captures, NOT assumption. Verified
 * against the actual scribe freeze region (400KB spanning 45 modal renders): the
 * bottom permissions/prompt chrome that PERSISTS while wedged — the "❯" prompt glyph
 * (135 hits), "⏵⏵" (119), "for agents" (4), "shift+tab to cycle" (2) — is unusable
 * here, because matching it would suppress a restart on every real wedge. Only the
 * statusline-driven "ready" hints are absent from the wedge (0 hits each) yet present
 * on a healthy idle agent (verified in marketing's live tail): "/clear to save N
 * tokens", "new task?", and "? for shortcuts". Those die exactly when the wedge bug
 * kills the statusline, which makes them a clean wedge-vs-idle discriminator.
 *
 * We deliberately bias toward MISS-not-FP: any of these hints present → treat as idle
 * → do not restart. A missed wedge degrades to the pre-existing manual-restart path; a
 * false restart of a healthy agent is the dangerous failure we are designing out.
 */
export function hasIdleInputPrompt(rawPtyOutput: string): boolean {
  if (!rawPtyOutput) return false;
  const normalized = normalizeCsi(rawPtyOutput);
  return /\/clear to save\b/i.test(normalized)
    || /\bnew task\?/i.test(normalized)
    || /\? for shortcuts/i.test(normalized);
}

/**
 * Replaces every CSI escape sequence with a single space and collapses whitespace, so
 * both the contiguous and the cursor-fragmented TUI render of a line normalize to the
 * same token stream. The CSI matcher uses the spec-correct final-byte class [@-~]
 * (0x40–0x7E), so it strips any cursor-move command at any column / terminal width.
 */
function normalizeCsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[@-~]/g, ' ').replace(/\s+/g, ' ');
}
