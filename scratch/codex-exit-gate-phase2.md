# CODEX EXIT-GATE — KB Phase-2 Hybrid Retrieval (BM25 + vector, RRF k=60)

You are the PRE-DEPLOY exit gate for a completed build. Return a verdict: **GO**, **FIX**, or **SCRAP**.
Be adversarial. This is the gate that decides whether code reaches a Logan-gated production flip.

## What this is
Phase-2 adds BM25 keyword retrieval fused with the existing vector retrieval via Reciprocal Rank
Fusion (RRF, k=60), behind a DEFAULT-OFF config flag `hybrid_search`, to fix lexical/exact-token
misses that pure vector buries (canonical case q07 "Aleric Heck AdOutreach"). Plan (codex PLAN-GO
ref 1781798564404): `orgs/cortex/agents/coder/scratch/hybrid-phase2-plan.md` (read it — it is the
contract you are gating against). RRF k=60 is PINNED by your prior plan-gate; retuning it is a new
plan-gate, not a FIX you can request here.

## Branch & how to review
- Branch `feat/kb-phase2-hybrid`, merge-base `main` = 31662d4. Run `git -C /Users/loganbronstein/cortextos diff 31662d4...HEAD` for the full diff.
- Core files to scrutinize:
  - `knowledge-base/scripts/mmrag.py` — FTS5 sidecar (fts_connect/fts_build/freshness), `fts_sanitize_query`, `hybrid_fuse` (RRF + candidate OR-inclusion + FTS-only hydration + stale-row prune), `cmd_query` hybrid block, JSON `rank_score`/`hybrid` fields.
  - `src/bus/knowledge-base.ts` — `shouldUseHybridSearch`, `KBHybridQueryError` fail-loud (escapes the outer swallow catch), `rank_score` ranking-key parse, sidecar-missing warn.
  - `dashboard/src/app/api/kb/search/route.ts` — same fail-loud (`KBHybridError` -> 500) + rank_score sort.
  - `knowledge-base/scripts/eval_harness.py` — `hybrid` view (`hybrid_rows`, `_hybrid_query_block`), `query_collection` 3-tuple, `_norm_rows`.
  - Tests: `tests/unit/bus/knowledge-base.test.ts` (33), `dashboard/.../kb/search/__tests__/route.test.ts` (4), `knowledge-base/scripts/test_eval_harness.py` (31), `test_hybrid.py` (16). All green this session.
- Offline lift evidence: `knowledge-base/eval/phase2-hybrid.console.txt` (47 lines — read this; do NOT read the 2266-line phase2-hybrid.json, the numbers below + console are sufficient).

## OFFLINE LIFT RESULT (the headline you are ruling on)
ONE hybrid-on harness run vs the Fix-A baseline, compared WITHIN the same run (hybrid view vs
flag_on_rows view = same query embeddings = immune to live-embedding non-determinism). Locked v1.1
eval set (sha256 b669c058, 20 queries / 18 scored / 2 negative controls) over the frozen snapshot
phase0-baseline-20260617T002417Z.

| metric | Fix-A baseline (flag_on_rows) | HYBRID | delta |
|---|---|---|---|
| Recall@5 | 0.8333 | 0.8333 | flat |
| Recall@20 | 0.8333 | 0.9444 | +0.111 |
| MRR | 0.6401 | 0.6887 | +0.0486 |
| FP-rate (controls) | 1.0 | 1.0 | unchanged |

- q07 LEX "Aleric Heck AdOutreach": MISS -> HIT @ rank #1 (R@5/@20 0/0 -> 1.0/1.0). BM25 surfaced
  agents/scribe/memory/2026-06-16.md, which is NOT vector-retrievable @20 corpus-wide. The target win.
- q14 RANK recovered @20 (0 -> 1.0).

## 4 DISCLOSURES (rule on each)
1. **q13 VEC REGRESSION.** q13 (VEC, agent-scribe) demoted rank #5 -> #9 (R@5 1.0 -> 0.0, still hits
   @20; rr 0.2 -> 0.111). RRF pushed a borderline vector hit below new lexical competitors. Net
   Recall@5 is FLAT (q07 +1 @5 offset by q13 -1 @5). The plan's "NO VEC regression" criterion is
   therefore VIOLATED. Is this an acceptable net-positive tradeoff for GO, a FIX (and what fix, given
   RRF k is pinned), or a SCRAP? This is the central question.
2. **Frozen-snapshot mutation, caught + restored.** During the offline lift I ran `mmrag fts-build
   --collection all` — but "all" is a LITERAL collection name (no "all" keyword), so
   get_or_create_collection("all") CREATED an empty `all` collection in the snapshot's chroma.sqlite3.
   I deleted it immediately; the 7 real collections were verified intact with original counts
   (boss 1229/codex 571/analyst 192/marketing 4754/shared-cortex 655/coder 204/scribe 888), no data
   loss. chroma.sqlite3 bytes changed by the create+delete churn but the collection set + per-collection
   data are restored. The offline-lift numbers above were produced by a SEPARATE, correct run
   (fts-build with NO --collection flag, 8493 chunks across 7 collections). Does this invalidate the
   measurement or the snapshot's value as a frozen baseline for future phases?
3. **Build-pin status.** NO `npm run build` was run this entire build — live `dist/` still equals
   main; all Phase-2 code lives only on the branch. Verification was typecheck (tsc --noEmit, no dist
   write) + vitest (runs src/ via transform, not dist) + python unittest + temp/eval sidecars. The
   build-to-live-dist happens only at the routed DEPLOY step AFTER your GO. Is this pre-deploy posture
   correct, or is there a leak where branch code could reach live agents before deploy?
4. **Harness fidelity note.** The harness queries mmrag at `--threshold 0`; the hybrid view applies NO
   cosine floor on ordering/recall (it trusts mmrag's hybrid candidate selection, which deliberately
   lets BM25 bypass the cosine floor — that is how q07 gets through). The negative-control FP check
   reads SIMILARITY (>= prod threshold 0.5), so the dropped floor cannot inflate FP (and it didn't:
   1.0 -> 1.0). In prod the wrapper calls mmrag at --threshold 0.5; the RRF vector ranking uses the
   top-(top_k*3) fetch order which is threshold-independent, so q13's demotion is judged real, not an
   artifact. Is this offline view prod-faithful enough to gate on, or does it over/under-state risk?

## ASK
Adversarially verify the hybrid implementation against the plan contract (RRF correctness, candidate
OR-inclusion, FTS-only hydration + stale prune, MATCH sanitizer, sidecar freshness on
ingest/delete/reset, fail-loud scoped to hybrid-enabled-only with non-hybrid neutral, ranking-key
parse on all 3 surfaces, default-off safety). Then rule on the 4 disclosures. HARD RULE — verify
real callsites: confirm the hybrid path is actually reached from the production query flow
(cmd_query when config hybrid_search=true), not dead code. Output:

VERDICT: GO | FIX | SCRAP
- If FIX: the SPECIFIC, minimal changes required (file:line), each tied to a contract violation or a
  real defect — not stylistic.
- If GO: confirm the q13 tradeoff is acceptable and state any conditions for the Logan-gated flip
  (e.g. monitoring, rollback = flag false + delete fts/).
- Reasoning for the central q13 call.
