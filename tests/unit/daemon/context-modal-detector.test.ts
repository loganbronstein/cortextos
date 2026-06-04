import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { detectContextLimitModal, hasIdleInputPrompt } from '../../../src/daemon/context-modal-detector';

// Real PTY captures from the 2026-06-04 incident, frozen into fixtures:
//  - wedge-frozen.bin   : scribe's actual wedged frame (modal + frozen "✻ … for 0s"
//                         spinner, NO input prompt) — the thing we MUST restart.
//  - idle-with-modal.bin: marketing's real buffer that CONTAINS the modal string AND
//                         the idle input bar ("new task? /clear to save N tokens") —
//                         a healthy agent that quoted the modal; MUST NOT restart.
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'context-modal');
const realWedge = readFileSync(join(FIXTURES, 'wedge-frozen.bin'), 'utf-8');
const realIdleWithModal = readFileSync(join(FIXTURES, 'idle-with-modal.bin'), 'utf-8');

describe('detectContextLimitModal', () => {
  it('1. matches the REAL contiguous modal capture (scribe wedge, 2026-06-04)', () => {
    expect(detectContextLimitModal(realWedge)).toBe(true);
  });

  it('2. matches the cursor-fragmented render (synthetic/defensive — no real capture was fragmented)', () => {
    // The TUI *can* redraw word-by-word, splitting each word with a CSI cursor-move.
    // All 45 real captures tonight were contiguous, so this is future-proofing the
    // normalizer: every \x1b[<n>G becomes a space and the two halves still co-occur.
    const fragmented =
      'Context\x1b[14Glimit\x1b[20Greached\x1b[28G·\x1b[30G/compact\x1b[39Gor\x1b[42G/clear\x1b[49Gto\x1b[52Gcontinue';
    expect(detectContextLimitModal(fragmented)).toBe(true);
  });

  it('3. matches a fragmented render at DIFFERENT columns/width (proves the CSI matcher is generic)', () => {
    // Different column numbers + a multi-param SGR mixed in — the spec-correct
    // final-byte class [@-~] strips them all regardless of the exact codes.
    const fragmentedWide =
      'Context\x1b[103Glimit\x1b[110;1Hreached · /compact\x1b[128G or /clear to continue';
    expect(detectContextLimitModal(fragmentedWide)).toBe(true);
  });

  it('4. does NOT match a stray "/compact" mention in prose (no co-occurrence)', () => {
    const prose = "I'll run /compact now to free up some space before the next task.";
    expect(detectContextLimitModal(prose)).toBe(false);
  });

  it('5. does NOT match a lone "Context limit reached" in prose (only one half present)', () => {
    const prose = 'The session hit a Context limit reached state earlier today and recovered.';
    expect(detectContextLimitModal(prose)).toBe(false);
  });

  it('6. returns false for empty input', () => {
    expect(detectContextLimitModal('')).toBe(false);
  });
});

describe('hasIdleInputPrompt', () => {
  it('7. is TRUE for the REAL healthy buffer that contains the modal + idle bar (marketing)', () => {
    // Sanity: the modal really is present in this capture…
    expect(detectContextLimitModal(realIdleWithModal)).toBe(true);
    // …and the idle input bar is detected, so the gate will refuse to restart it.
    expect(hasIdleInputPrompt(realIdleWithModal)).toBe(true);
  });

  it('8. is FALSE for the REAL wedged frame (no input bar — agent cannot accept input)', () => {
    expect(hasIdleInputPrompt(realWedge)).toBe(false);
  });

  it('9. detects each idle marker individually (statusline-driven "ready" hints)', () => {
    expect(hasIdleInputPrompt('… ➜ · new task? /clear to save 126.3k tokens')).toBe(true);
    expect(hasIdleInputPrompt('some output … ? for shortcuts')).toBe(true);
    // The wedge bottom-bar chrome that PERSISTS while frozen must NOT count as idle,
    // or we would suppress every real restart (verified present in the freeze region).
    expect(hasIdleInputPrompt('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(hasIdleInputPrompt('')).toBe(false);
  });
});
