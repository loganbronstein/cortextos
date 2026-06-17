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
                     env: dict, top_k: int = TOP_K) -> list[tuple[str, float]]:
    """Run `mmrag.py query` against ONE collection; return [(full_source_path,
    similarity)] in rank order. Raises RuntimeError on non-zero exit / no JSON /
    parse error (plan §F: fail loud, never silent-degrade to empty)."""
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
            ranked.append((src, float(r.get("similarity", 0.0))))
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


# The three retrieval views (see module docstring). Order = report order.
VIEWS = ("all7_merged", "prod_current", "prod_merged_candidate")


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

        # One query per collection at threshold 0 (top-k 20); all three views are
        # derived from this so prod fidelity costs no extra mmrag calls.
        by_col = {c: query_fn(python, mmrag, c, q["query"], env) for c in collections}

        # View 1 — ALL-7 MERGED: corpus-wide retrievability reference (threshold 0).
        all7_merged = merge_ranked(list(by_col.values()))

        # View 2 — PROD_CURRENT: EXACT wrapper (shared-first concat @ prod threshold,
        # no re-sort). FP for negative controls computed across reachable paths.
        prod_current = prod_current_ranked(by_col, col, PROD_SHARED, prod_threshold)
        pc_fp = prod_current_fp(by_col, col, collections, PROD_SHARED, prod_threshold) if negative else None

        # View 3 — PROD_MERGED_CANDIDATE: shared + agent MERGED by sim (threshold 0),
        # a future query-layer target (NOT current prod).
        cand_cols = [PROD_SHARED] + ([col] if isinstance(col, str) and col.startswith("agent-") else [])
        prod_merged_candidate = merge_ranked([by_col.get(c, []) for c in cand_cols])

        per_query.append({
            "id": q.get("id"), "tag": q.get("tag"), "query": q["query"],
            "collection": col, "negative_control": negative,
            "expected_sources": fragments,
            "all7_merged": _query_block(all7_merged, fragments, negative, prod_threshold),
            "prod_current": _query_block(prod_current, fragments, negative, prod_threshold, fp=pc_fp),
            "prod_merged_candidate": _query_block(prod_merged_candidate, fragments, negative, prod_threshold),
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
    """Scored queries whose expected source NEVER retrieved (recall@20==0) in the
    ALL-7 MERGED view = a real fix-mapping-or-reingest signal (surface loud). Uses
    the corpus-wide reference: if it's not retrievable across all 7, it can't be
    reached by prod either."""
    return [{"id": r["id"], "tag": r["tag"], "query": r["query"],
             "collection": r["collection"], "expected_sources": r["expected_sources"]}
            for r in per_query
            if not r["negative_control"] and r["all7_merged"]["recall@20"] == 0.0]


VIEW_LABELS = {
    "all7_merged": "ALL-7 MERGED — corpus-wide RETRIEVABILITY REFERENCE (threshold 0, NOT prod)",
    "prod_current": "PROD_CURRENT — real wrapper (shared-first concat, threshold 0.5, no re-sort)",
    "prod_merged_candidate": "PROD_MERGED_CANDIDATE — future query-layer target (merged, threshold 0), NOT prod",
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
    print("\nPer-collection (PROD_CURRENT real / ALL-7 reference):")
    for c, b in report["per_collection"].items():
        pc, ref = b["prod_current"], b["all7_merged"]
        print(f"  {c:16s} n={pc['n_scored']:2d}  "
              f"prod R@5={pc['recall@5']} R@20={pc['recall@20']} MRR={pc['mrr']}  |  "
              f"ref R@5={ref['recall@5']} R@20={ref['recall@20']} MRR={ref['mrr']}")
    misses = report["misses"]
    if misses:
        print(f"\n⚠ {len(misses)} EXPECTED-SOURCE MISS(ES) (recall@20==0 — fix mapping or re-ingest):")
        for m in misses:
            print(f"    [{m['id']} {m['tag']}] {m['query']!r} -> expected {m['expected_sources']} ({m['collection']})")
    else:
        print("\nNo expected-source misses (every scored query's source retrieved within top-20).")
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
