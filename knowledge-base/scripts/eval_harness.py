#!/usr/bin/env python3
"""
Phase-0 retrieval eval harness — Cortex KB/RAG Contextual-Retrieval upgrade.

WHAT THIS MEASURES (plan: Vault/Research/cortextos/contextual-retrieval-upgrade-plan.md §C/§G):
  The current pure-vector retrieval failure-rate on the *Cortex* corpus, as a
  BASELINE to compare each future layer (hybrid -> rerank -> contextual) against.
  A query "fails" if its expected source doc is NOT in the returned top-k.

THREE RETRIEVAL VIEWS (plan §A Fix A — `kb-query --scope all` does NOT see all 7
collections, only shared + the caller's private one). codex Phase-0 exit-gate:
Phase 0 is HONEST measurement, so the prod view must match the REAL wrapper
(src/bus/knowledge-base.ts:158-224) — which for scope=all CONCATS shared-<org>
FIRST then the agent-private collection, each threshold-filtered, with NO global
merge/re-sort. The three views are kept distinct; none is presented as another:
  1. ALL-7 MERGED          : query all 7 collections via mmrag.py, MERGE by
              similarity (threshold 0), dedup by best sim. This is the corpus-wide
              RETRIEVABILITY REFERENCE — what is *physically* retrievable across
              the whole corpus. NOT prod (prod can't reach all 7).
  2. PROD_CURRENT          : EXACT production wrapper. Per-collection threshold
              filter (prod threshold 0.5, mmrag uses similarity >= threshold),
              then CONCAT shared-cortex results FIRST, agent-private appended, with
              NO re-sort and NO global merge (dedup preserves first-seen order).
              This is the real-world retrieval an agent gets today.
  3. PROD_MERGED_CANDIDATE : the shared + agent collections MERGED by similarity
              (threshold 0) — a FUTURE query-layer target (rank shared and private
              together), shown as a CANDIDATE for comparison. NOT current prod.

PHASE-1 FIX A A/B (the production-faithful lift measurement). Fix A changes the
prod wrapper's scope=all combination from shared-first concat to merge-by-score,
behind the `merge_collections_by_score` flag. Because the wrapper concatenates
ROWS and never dedups, the faithful A/B is ROW-LEVEL no-dedup at the prod 0.5
threshold (NOT the source-level deduped views above, which are kept only as
labeled references / Phase-0 continuity):
  flag_off_rows : filter@0.5 -> shared rows ++ agent rows (shared first), no sort
  flag_on_rows  : same rows -> stable score-desc sort (Fix A)
The Phase-1 lift claim is flag_on_rows vs flag_off_rows ONLY.

MATCHING (scribe 2026-06-17): expected_sources are PATH-SUFFIX FRAGMENTS that are
  substring-matched against the FULL source path — NOT basenames — because
  `MEMORY.md` collides across all 6 agents (agents/boss/MEMORY.md vs
  agents/scribe/MEMORY.md). Full source paths are kept through the merge; a hit =
  any expected fragment is a substring of a returned full path.

METRICS (plan §C): per scored query (excluding negative controls):
  - Recall@5  (user-facing top_k) and Recall@20 (Anthropic comparability)
  - MRR       (mean reciprocal rank of the first correct source — the rerank win)
  - False-positive rate on NEGATIVE controls (a control returning a confident
    match >= prod threshold = bad).
  Reported per-collection / per-agent AND aggregate.

MISSES (scribe + plan §F): kb-ingest is additive, so an expected source that
  never retrieves (recall@20 == 0) is a REAL fix-the-mapping-or-reingest signal,
  not noise. The report lists every such miss LOUDLY — never silently degrade.

FROZEN SNAPSHOT (plan §C): retrieval runs against a frozen copy of the chromadb
  dir so deltas are layer-attributable. Defaults to eval_set["frozen_snapshot"];
  override with --snapshot-dir.

PROVISIONAL: baseline is PROVISIONAL until the golden set is locked
  (eval_set["locked_at_utc"] present / version endswith "-locked"). v1.1 is
  locked -> real baseline.

FAIL-LOUD (plan §F Fix F): a mmrag query failure (non-zero exit / unparseable
  JSON) RAISES — never silently swallowed into empty results.

DEPENDENCIES: Python stdlib only. No new runtime pip (plan §D). Mocked unit tests
  (test_eval_harness.py) cover metric/merge/match logic without a live KB.

EVAL-SET SCHEMA (scribe owns CONTENT + locks it; coder owns this code).
  Per query: {id, tag:[VEC|LEX|CTX|RANK], query, expected_sources:[<path-suffix
  fragment>...], collection:"shared-cortex|agent-<name>|any", negative_control}.
  Top-level also carries: version, locked_at_utc, frozen_snapshot,
  collections_manifest.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

# The 7 Cortex collections (plan §A). Overridable via eval_set collections_manifest.
DEFAULT_COLLECTIONS = [
    "shared-cortex",
    "agent-marketing",
    "agent-boss",
    "agent-scribe",
    "agent-codex",
    "agent-coder",
    "agent-analyst",
]
PROD_SHARED = "shared-cortex"
DEFAULT_PROD_THRESHOLD = 0.5  # prod similarity_threshold; control match >= this = FP
TOP_K = 20  # deepest cutoff measured (Recall@20)


# --------------------------------------------------------------------------
# Pure match / metric / merge functions (no I/O — unit-tested)
# --------------------------------------------------------------------------
def matches(full_path: str, fragments: list[str]) -> bool:
    """True if any expected path-suffix fragment is a substring of the full path."""
    return any(frag and frag in full_path for frag in fragments)


def merge_ranked(per_collection: list[list[tuple[str, float]]]) -> list[tuple[str, float]]:
    """Merge per-collection [(full_source_path, similarity)] lists into one ranking.

    Dedup by FULL path keeping its best similarity across collections, sorted by
    similarity desc, ties broken by path for determinism."""
    best: dict[str, float] = {}
    for results in per_collection:
        for path, sim in results:
            if path not in best or sim > best[path]:
                best[path] = sim
    return sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))


def concat_preserve_order(per_collection_in_order: list[list[tuple[str, float]]]) -> list[tuple[str, float]]:
    """Concat per-collection [(path, sim)] lists IN THE GIVEN ORDER, deduping by
    full path keeping the FIRST occurrence. This is the prod wrapper's shape
    (src/bus/knowledge-base.ts:217-224): allResults.concat(parseOutput(...)) per
    collection in scope order, NO re-sort, NO cross-collection merge. The wrapper
    itself doesn't dedup, but dedup-preserving-order is the measurement-faithful
    representation of a source's effective first-seen rank (codex-specified)."""
    seen: set[str] = set()
    out: list[tuple[str, float]] = []
    for results in per_collection_in_order:
        for path, sim in results:
            if path not in seen:
                seen.add(path)
                out.append((path, sim))
    return out


def prod_current_ranked(by_col: dict, col, shared: str, threshold: float) -> list[tuple[str, float]]:
    """EXACT current prod wrapper (scope=all, src/bus/knowledge-base.ts:158-224):
    threshold-filter each collection (mmrag: similarity >= threshold), then CONCAT
    shared-<org> FIRST and the query's agent-private collection appended, NO re-sort.
    A `shared-cortex` query is shared-only; `any` (negative controls) has no single
    agent path, so its ranked view is shared-only and its FP is computed separately
    across every path via prod_current_fp."""
    def keep(c):
        return [(p, s) for p, s in by_col.get(c, []) if s >= threshold]
    if isinstance(col, str) and col.startswith("agent-"):
        return concat_preserve_order([keep(shared), keep(col)])
    return concat_preserve_order([keep(shared)])


def prod_current_fp(by_col: dict, col, collections: list[str], shared: str, threshold: float) -> bool:
    """Negative-control false positive under the CURRENT prod wrapper. A control is
    a FP if any reachable path returns a confident (>= threshold) match.
      - `any`        : FP if ANY of the 7 collections has a >= threshold result
                       (each agent path = shared + that agent; shared is common).
      - `agent-<x>`  : FP if shared OR that agent returns >= threshold.
      - `shared-cortex`: FP if shared returns >= threshold."""
    def hit(c):
        return any(s >= threshold for _, s in by_col.get(c, []))
    if col == "any":
        return any(hit(c) for c in collections)
    if isinstance(col, str) and col.startswith("agent-"):
        return hit(shared) or hit(col)
    return hit(shared)


def sort_by_score_stable(rows: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Stable score-DESC sort matching the TS wrapper mergeByScore (Fix A flag ON):
    ties keep original (shared-first) order via explicit index decoration, NOT by
    relying on sort stability. NO dedup — duplicate-source rows are preserved."""
    decorated = list(enumerate(rows))
    decorated.sort(key=lambda d: (-d[1][1], d[0]))
    return [r for _, r in decorated]


def fix_a_rows(by_col: dict, col, shared: str, threshold: float, merge: bool) -> list[tuple[str, float]]:
    """ROW-LEVEL (NO dedup) prod view for Phase-1 Fix A — the production-faithful
    A/B basis (the wrapper concatenates rows and never dedups):
      flag OFF (merge=False): filter@threshold -> shared rows ++ agent rows
                              (shared first), NO re-sort  (= today's prod ordering)
      flag ON  (merge=True):  same rows -> stable score-desc sort  (= Fix A)
    A `shared-cortex` / `any` query has no agent path -> shared rows only (its
    recall is None for controls; its FP is computed via prod_current_fp)."""
    def keep(c):
        return [(p, s) for p, s in by_col.get(c, []) if s >= threshold]
    rows = keep(shared)
    if isinstance(col, str) and col.startswith("agent-"):
        rows = rows + keep(col)
    return sort_by_score_stable(rows) if merge else rows


def _norm_rows(rows) -> list[tuple[str, float, float]]:
    """Normalize query rows to (path, similarity, rank_score). Accepts 3-tuples from
    query_collection (Phase-2) OR 2-tuples (path, sim) from older callers / mocked
    tests, where rank_score defaults to similarity (vector-only / back-compat)."""
    out = []
    for r in rows:
        if len(r) >= 3:
            out.append((r[0], float(r[1]), float(r[2])))
        else:
            out.append((r[0], float(r[1]), float(r[1])))
    return out


def hybrid_rows(by_col3: dict, col, shared: str) -> list[tuple[str, float, float]]:
    """Phase-2 HYBRID prod view — the Fix-A scope=all wrapper now keyed on rank_score.
    Compose scope=all ROW-LEVEL (shared ++ the query's agent collection, NO dedup),
    then ORDER BY rank_score desc (= RRF when mmrag ran with hybrid_search on, = similarity
    when off; ties keep shared-first via index decoration). Deliberately applies NO
    similarity floor: mmrag's hybrid candidate selection already lets a strong lexical /
    low-cosine hit (q07) through by bypassing the cosine floor, so re-imposing a floor here
    would erase the very lift being measured. Rows stay (path, similarity, rank_score) so
    recall reads rank_score order while FP reads similarity (the dropped-floor risk guard)."""
    rows = list(by_col3.get(shared, []))
    if isinstance(col, str) and col.startswith("agent-"):
        rows = rows + list(by_col3.get(col, []))
    decorated = list(enumerate(rows))
    decorated.sort(key=lambda d: (-d[1][2], d[0]))
    return [r for _, r in decorated]


def ranked_paths(merged: list[tuple[str, float]]) -> list[str]:
    return [p for p, _ in merged]


def recall_at_k(paths: list[str], fragments: list[str], k: int):
    """1.0 if any expected fragment matches a top-k path, else 0.0. None for a
    negative control (no expected sources) — excluded from the recall mean."""
    if not fragments:
        return None
    return 1.0 if any(matches(p, fragments) for p in paths[:k]) else 0.0


def reciprocal_rank(paths: list[str], fragments: list[str]):
    """1/rank of the first matching path, else 0.0. None for negative controls."""
    if not fragments:
        return None
    for i, p in enumerate(paths, start=1):
        if matches(p, fragments):
            return 1.0 / i
    return 0.0


def is_false_positive(merged: list[tuple[str, float]], threshold: float) -> bool:
    """Negative control: True if anything was returned at/above threshold."""
    return any(sim >= threshold for _, sim in merged)


def mean(values: list):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


# --------------------------------------------------------------------------
# Retrieval (I/O — mocked in tests). FAIL LOUD: never swallow a query error.
# --------------------------------------------------------------------------
def query_collection(python: str, mmrag: str, collection: str, query: str,
                     env: dict, top_k: int = TOP_K) -> list[tuple[str, float, float]]:
    """Run `mmrag.py query` against ONE collection; return [(full_source_path,
    similarity, rank_score)] in rank order. Raises RuntimeError on non-zero exit /
    no JSON / parse error (plan §F: fail loud, never silent-degrade to empty)."""
    proc = subprocess.run(
        [python, mmrag, "query", query,
         "--collection", collection,
         "--top-k", str(top_k),
         "--threshold", "0",
         "--max-tokens", "0",
         "--json"],
        capture_output=True, text=True, env=env, timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"mmrag query failed (exit {proc.returncode}) collection={collection} "
            f"query={query!r}\nSTDERR: {proc.stderr.strip()[:500]}")
    out = proc.stdout.strip()
    start = out.find("{")
    if start == -1:
        raise RuntimeError(
            f"mmrag query produced no JSON collection={collection} query={query!r}\n"
            f"STDOUT: {out[:500]}")
    try:
        data = json.loads(out[start:])
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"mmrag query JSON parse error collection={collection} query={query!r}: {e}")
    ranked = []
    for r in data.get("results", []):
        src = r.get("source") or ""  # FULL path (matching needs the path, not basename)
        if src:
            sim = float(r.get("similarity", 0.0))
            # Phase-2: rank_score is mmrag's ORDERING key (= RRF when hybrid_search is on,
            # = similarity otherwise). Captured alongside raw cosine so the hybrid view can
            # order by rank_score while threshold/FP stay on similarity. Falls back to
            # similarity for non-hybrid / older mmrag output that omits rank_score.
            rank = float(r.get("rank_score", sim))
            ranked.append((src, sim, rank))
    return ranked


# --------------------------------------------------------------------------
# Eval-set loading + the run
# --------------------------------------------------------------------------
def is_locked(eval_set: dict) -> bool:
    return bool(eval_set.get("locked_at_utc")) or str(eval_set.get("version", "")).endswith("-locked")


def load_eval_set(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data.get("queries"), list):
        raise ValueError(f"eval-set {path} has no 'queries' list")
    return data


def _collections(eval_set: dict) -> list[str]:
    man = eval_set.get("collections_manifest")
    if isinstance(man, dict) and man:
        return list(man.keys())
    if isinstance(man, list) and man:
        return [c.get("collection", c) if isinstance(c, dict) else c for c in man]
    return DEFAULT_COLLECTIONS


# Retrieval views (see module docstring). Order = report order.
# Phase-1 Fix A headline = the row-level no-dedup A/B (flag_off_rows vs
# flag_on_rows). Phase-2 headline = `hybrid` (rank_score-ordered, run against a
# hybrid_search-on config) vs the Fix-A baseline (flag_on_rows). The rest are
# labeled REFERENCES (source-level / corpus-wide).
VIEWS = ("flag_off_rows", "flag_on_rows", "all7_merged", "prod_current", "prod_merged_candidate", "hybrid")


def evaluate(eval_set: dict, python: str, mmrag: str, base_env: dict,
             snapshot_dir, prod_threshold: float, query_fn=query_collection,
             eval_set_path=None, eval_set_sha256=None) -> dict:
    collections = _collections(eval_set)
    env = dict(base_env)
    if snapshot_dir:
        env["MMRAG_CHROMADB_DIR"] = snapshot_dir

    per_query = []
    for q in eval_set["queries"]:
        fragments = list(q.get("expected_sources", []))
        negative = bool(q.get("negative_control")) or not fragments
        col = q.get("collection")

        # One query per collection at threshold 0 (top-k 20); all views are derived
        # from this so prod fidelity costs no extra mmrag calls. by_col3 carries
        # rank_score (Phase-2); by_col is the (path, sim) projection the vector-ordered
        # views use unchanged. _norm_rows tolerates 2-tuple callers/mocks (rank=sim).
        by_col3 = {c: _norm_rows(query_fn(python, mmrag, c, q["query"], env)) for c in collections}
        by_col = {c: [(p, s) for p, s, _ in rows] for c, rows in by_col3.items()}

        # View 1 — ALL-7 MERGED: corpus-wide retrievability reference (threshold 0).
        all7_merged = merge_ranked(list(by_col.values()))

        # View 2 — PROD_CURRENT: EXACT wrapper (shared-first concat @ prod threshold,
        # no re-sort, source-level dedup-preserving-order). FP for negative controls
        # computed across reachable paths. Kept as a labeled REFERENCE.
        prod_current = prod_current_ranked(by_col, col, PROD_SHARED, prod_threshold)
        pc_fp = prod_current_fp(by_col, col, collections, PROD_SHARED, prod_threshold) if negative else None

        # View 3 — PROD_MERGED_CANDIDATE: shared + agent MERGED by sim (threshold 0),
        # source-level. A future ceiling reference (NOT current prod, NOT Fix A).
        cand_cols = [PROD_SHARED] + ([col] if isinstance(col, str) and col.startswith("agent-") else [])
        prod_merged_candidate = merge_ranked([by_col.get(c, []) for c in cand_cols])

        # Phase-1 FIX A headline A/B — ROW-LEVEL, NO dedup, prod threshold 0.5,
        # production-faithful (the wrapper concatenates rows and never dedups):
        #   flag_off_rows = shared-first concat, no re-sort (today's prod ordering)
        #   flag_on_rows  = same rows, stable score-desc sort (Fix A)
        # FP is identical for both (sort/dedup don't change whether a confident
        # row exists) -> reuse the reachable-path control FP.
        flag_off_rows = fix_a_rows(by_col, col, PROD_SHARED, prod_threshold, merge=False)
        flag_on_rows = fix_a_rows(by_col, col, PROD_SHARED, prod_threshold, merge=True)
        rows_fp = pc_fp

        # Phase-2 HYBRID view — scope=all composition ordered by rank_score (= RRF when
        # mmrag ran hybrid_search-on, else = similarity). Headline vs the Fix-A baseline
        # (flag_on_rows): q07 LEX miss->hit, no VEC regression; FP read by SIMILARITY so
        # the dropped cosine floor can't inflate negative-control FP.
        hybrid = hybrid_rows(by_col3, col, PROD_SHARED)

        per_query.append({
            "id": q.get("id"), "tag": q.get("tag"), "query": q["query"],
            "collection": col, "negative_control": negative,
            "expected_sources": fragments,
            "flag_off_rows": _query_block(flag_off_rows, fragments, negative, prod_threshold, fp=rows_fp),
            "flag_on_rows": _query_block(flag_on_rows, fragments, negative, prod_threshold, fp=rows_fp),
            "all7_merged": _query_block(all7_merged, fragments, negative, prod_threshold),
            "prod_current": _query_block(prod_current, fragments, negative, prod_threshold, fp=pc_fp),
            "prod_merged_candidate": _query_block(prod_merged_candidate, fragments, negative, prod_threshold),
            "hybrid": _hybrid_query_block(hybrid, fragments, negative, prod_threshold),
        })

    return {
        "provenance": {
            "eval_set_version": eval_set.get("version"),
            "eval_set_path": eval_set_path,
            "eval_set_sha256": eval_set_sha256,
            "locked_at_utc": eval_set.get("locked_at_utc"),
            "snapshot_dir": snapshot_dir,
            "collections": collections,
            "prod_threshold": prod_threshold,
        },
        "provisional": not is_locked(eval_set),
        "aggregate": {v: _agg(per_query, v) for v in VIEWS},
        "per_collection": _per_collection(per_query),
        "misses": _misses(per_query),
        "per_query": per_query,
    }


_AUTO_FP = "__auto__"


def _query_block(ranked, fragments, negative, threshold, fp=_AUTO_FP) -> dict:
    """Build a per-query metric block for one view. `fp` defaults to the standard
    threshold check over the ranked list; PROD_CURRENT passes an explicit value
    (its control FP spans multiple reachable paths, not one merged list)."""
    paths = ranked_paths(ranked)
    if fp == _AUTO_FP:
        fp = is_false_positive(ranked, threshold) if negative else None
    return {
        "recall@5": recall_at_k(paths, fragments, 5),
        "recall@20": recall_at_k(paths, fragments, 20),
        "rr": reciprocal_rank(paths, fragments),
        "false_positive": fp,
        "top5": paths[:5],
    }


def _hybrid_query_block(rows3, fragments, negative, threshold) -> dict:
    """Per-query metric block for the Phase-2 HYBRID view. rows3 = (path, sim, rank_score)
    ALREADY ordered by rank_score (hybrid_rows). Recall/MRR read that rank_score order;
    the false-positive check reads SIMILARITY (a negative control is an FP only if a
    CONFIDENT cosine match >= threshold is returned — the dropped cosine floor must not
    inflate FP). Same output shape as _query_block so _agg treats every view uniformly."""
    paths = [p for p, _s, _r in rows3]
    fp = (any(s >= threshold for _p, s, _r in rows3)) if negative else None
    return {
        "recall@5": recall_at_k(paths, fragments, 5),
        "recall@20": recall_at_k(paths, fragments, 20),
        "rr": reciprocal_rank(paths, fragments),
        "false_positive": fp,
        "top5": paths[:5],
    }


def _agg(rows, view) -> dict:
    scored = [r for r in rows if not r["negative_control"]]
    controls = [r for r in rows if r["negative_control"]]
    fps = [r[view]["false_positive"] for r in controls if r[view]["false_positive"] is not None]
    return {
        "n_scored": len(scored),
        "recall@5": mean([r[view]["recall@5"] for r in scored]),
        "recall@20": mean([r[view]["recall@20"] for r in scored]),
        "mrr": mean([r[view]["rr"] for r in scored]),
        "n_controls": len(controls),
        "false_positive_rate": round(sum(fps) / len(fps), 4) if fps else None,
    }


def _per_collection(per_query) -> dict:
    by = {}
    for r in per_query:
        by.setdefault(r["collection"] or "(none)", []).append(r)
    return {c: {v: _agg(rows, v) for v in VIEWS}
            for c, rows in sorted(by.items())}


def _misses(per_query) -> list:
    """Scored queries whose expected source is NOT retrieved within top-20 by the
    POST-FIX-A PRODUCTION path (flag_on_rows) = the real fix-mapping-or-reingest
    signal. NOTE: all7_merged is the WRONG basis for this — the 7-collection merge
    has more competing rows, so it can spuriously 'miss' a source that the prod
    path (shared + the query's own agent collection) actually retrieves. We surface
    the prod-path miss and annotate whether the corpus can retrieve it at all
    (all7 @20) to distinguish 'reingest needed' from 'ranking/noise'."""
    out = []
    for r in per_query:
        if r["negative_control"] or r["flag_on_rows"]["recall@20"] != 0.0:
            continue
        out.append({"id": r["id"], "tag": r["tag"], "query": r["query"],
                    "collection": r["collection"], "expected_sources": r["expected_sources"],
                    "corpus_retrievable_all7@20": r["all7_merged"]["recall@20"] == 1.0})
    return out


VIEW_LABELS = {
    "flag_off_rows": "FLAG OFF (prod today) — shared-first concat, ROW-LEVEL no-dedup, threshold 0.5",
    "flag_on_rows": "FLAG ON (Fix A) — merged by score, ROW-LEVEL no-dedup, threshold 0.5",
    "all7_merged": "ALL-7 MERGED — corpus-wide RETRIEVABILITY REFERENCE (threshold 0, NOT prod)",
    "prod_current": "PROD_CURRENT (ref) — wrapper concat, SOURCE-LEVEL dedup (= locked Phase-0 0.33)",
    "prod_merged_candidate": "PROD_MERGED_CANDIDATE (ref) — source-level merge, threshold 0 (ceiling)",
    "hybrid": "HYBRID (Phase-2) — scope=all by rank_score (RRF when hybrid_search on), FP by similarity",
}


def print_report(report: dict) -> None:
    p = report["provenance"]
    print("=" * 74)
    if report["provisional"]:
        print("  ⚠ PROVISIONAL — eval-set NOT locked. Numbers directional; do not cite as final.")
    else:
        print(f"  LOCKED baseline (eval-set locked {p['locked_at_utc']}).")
    print(f"  eval-set v{p['eval_set_version']} | snapshot={p['snapshot_dir'] or 'LIVE (NOT frozen!)'}")
    if p.get("eval_set_path"):
        print(f"  eval-set path={p['eval_set_path']}")
    if p.get("eval_set_sha256"):
        print(f"  eval-set sha256={p['eval_set_sha256']}")
    print("=" * 74)
    for view in VIEWS:
        a = report["aggregate"][view]
        print(f"\n[{VIEW_LABELS[view]}]\n  n={a['n_scored']} scored / {a['n_controls']} controls")
        print(f"  Recall@5={a['recall@5']}  Recall@20={a['recall@20']}  MRR={a['mrr']}  "
              f"FP-rate={a['false_positive_rate']}")
    print("\nPer-collection FIX A A/B (flag OFF -> flag ON, row-level @0.5):")
    for c, b in report["per_collection"].items():
        off, on = b["flag_off_rows"], b["flag_on_rows"]
        print(f"  {c:16s} n={off['n_scored']:2d}  "
              f"OFF R@5={off['recall@5']} R@20={off['recall@20']} MRR={off['mrr']}  ->  "
              f"ON R@5={on['recall@5']} R@20={on['recall@20']} MRR={on['mrr']}")
    misses = report["misses"]
    if misses:
        print(f"\n⚠ {len(misses)} PROD-PATH MISS(ES) (flag_on_rows recall@20==0 — fix mapping or re-ingest):")
        for m in misses:
            tail = "NOT vector-retrievable corpus-wide @20 (hybrid Phase-2 or reingest)" \
                if not m.get("corpus_retrievable_all7@20") \
                else "corpus CAN retrieve it via vector (ranking gap — rerank Phase-2 may help)"
            print(f"    [{m['id']} {m['tag']}] {m['query']!r} -> expected {m['expected_sources']} "
                  f"({m['collection']}) — {tail}")
    else:
        print("\nNo prod-path misses (every scored query's source retrieved within top-20 by flag_on).")
    if report["provisional"]:
        print("\n⚠ PROVISIONAL — see banner.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Phase-0 KB retrieval eval harness (baseline).")
    ap.add_argument("--eval-set", required=True, help="path to golden-set JSON")
    ap.add_argument("--snapshot-dir", default=None,
                    help="frozen chromadb dir (defaults to eval_set.frozen_snapshot)")
    ap.add_argument("--prod-threshold", type=float, default=DEFAULT_PROD_THRESHOLD)
    ap.add_argument("--mmrag", default=str(Path(__file__).with_name("mmrag.py")))
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--out", default=None, help="write the full JSON report here")
    args = ap.parse_args()

    eval_set = load_eval_set(args.eval_set)
    snapshot = args.snapshot_dir or eval_set.get("frozen_snapshot")
    with open(args.eval_set, "rb") as f:
        eval_set_sha256 = hashlib.sha256(f.read()).hexdigest()
    report = evaluate(eval_set, args.python, args.mmrag, dict(os.environ),
                      snapshot, args.prod_threshold,
                      eval_set_path=args.eval_set, eval_set_sha256=eval_set_sha256)
    print_report(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\nFull report -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
