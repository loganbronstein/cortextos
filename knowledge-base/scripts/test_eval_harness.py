#!/usr/bin/env python3
"""Mocked unit tests for the Phase-0 KB eval harness (plan §D: mocked, no live KB).

Run:  python3 -m unittest test_eval_harness   (from knowledge-base/scripts/)
Pure stdlib (unittest + unittest.mock); no ChromaDB / Gemini / network.

Matching is PATH-SUFFIX FRAGMENT vs FULL source path (not basename) — MEMORY.md
collides across agents, so tests assert path-disambiguated matching.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eval_harness as eh  # noqa: E402


class TestMatchAndMetrics(unittest.TestCase):
    def test_matches_full_path_fragment(self):
        boss = "/x/orgs/cortex/agents/boss/MEMORY.md"
        scribe = "/x/orgs/cortex/agents/scribe/MEMORY.md"
        # bare basename would match BOTH (the bug we avoid); path fragment disambiguates
        self.assertTrue(eh.matches(boss, ["agents/boss/MEMORY.md"]))
        self.assertFalse(eh.matches(scribe, ["agents/boss/MEMORY.md"]))
        self.assertTrue(eh.matches("/x/shared/sa-creative-rules.md", ["sa-creative-rules.md"]))

    def test_merge_ranked_dedup_by_full_path_best_sim(self):
        a = [("/x/a.md", 0.9), ("/x/b.md", 0.4)]
        b = [("/x/b.md", 0.7), ("/x/c.md", 0.5)]
        self.assertEqual(eh.merge_ranked([a, b]),
                         [("/x/a.md", 0.9), ("/x/b.md", 0.7), ("/x/c.md", 0.5)])

    def test_merge_ranked_tie_break_by_path(self):
        merged = eh.merge_ranked([[("/x/z.md", 0.5), ("/x/a.md", 0.5)]])
        self.assertEqual([p for p, _ in merged], ["/x/a.md", "/x/z.md"])

    def test_recall_at_k(self):
        paths = [f"/x/{c}.md" for c in "abcdef"]
        self.assertEqual(eh.recall_at_k(paths, ["c.md"], 5), 1.0)
        self.assertEqual(eh.recall_at_k(paths, ["f.md"], 5), 0.0)    # rank 6, outside top-5
        self.assertEqual(eh.recall_at_k(paths, ["f.md"], 20), 1.0)
        self.assertIsNone(eh.recall_at_k(paths, [], 5))              # negative control

    def test_reciprocal_rank(self):
        paths = ["/x/x.md", "/x/target.md", "/x/y.md"]
        self.assertEqual(eh.reciprocal_rank(paths, ["target.md"]), 0.5)
        self.assertEqual(eh.reciprocal_rank(["/x/x.md"], ["target.md"]), 0.0)
        self.assertIsNone(eh.reciprocal_rank(paths, []))

    def test_is_false_positive(self):
        self.assertTrue(eh.is_false_positive([("/x/a.md", 0.6)], 0.5))
        self.assertFalse(eh.is_false_positive([("/x/a.md", 0.3)], 0.5))
        self.assertFalse(eh.is_false_positive([], 0.5))

    def test_mean_filters_none(self):
        self.assertEqual(eh.mean([1.0, 0.0, None, 1.0]), round(2 / 3, 4))
        self.assertIsNone(eh.mean([None, None]))
        self.assertIsNone(eh.mean([]))

    def test_is_locked(self):
        self.assertTrue(eh.is_locked({"locked_at_utc": "2026-06-17T00:24Z"}))
        self.assertTrue(eh.is_locked({"version": "1.1-locked"}))
        self.assertFalse(eh.is_locked({"version": "1.0-draft"}))


class TestQueryCollectionFailLoud(unittest.TestCase):
    """Plan §F Fix F: a query failure must RAISE, never silently return empty."""

    def _run(self, returncode=0, stdout="", stderr=""):
        m = mock.Mock(returncode=returncode, stdout=stdout, stderr=stderr)
        with mock.patch.object(eh.subprocess, "run", return_value=m):
            return eh.query_collection("py", "mmrag.py", "shared-cortex", "q", {})

    def test_nonzero_exit_raises(self):
        with self.assertRaises(RuntimeError):
            self._run(returncode=1, stderr="boom")

    def test_no_json_raises(self):
        with self.assertRaises(RuntimeError):
            self._run(stdout="not json at all")

    def test_bad_json_raises(self):
        with self.assertRaises(RuntimeError):
            self._run(stdout="prefix {bad json")

    def test_good_json_keeps_full_paths(self):
        payload = ('log line\n{"results": ['
                   '{"source": "/x/agents/boss/MEMORY.md", "similarity": 0.9, "filename": "MEMORY.md"},'
                   '{"source": "/x/b.md", "similarity": 0.4}]}')
        ranked = self._run(stdout=payload)
        # FULL path retained (not basename) so matching can disambiguate
        self.assertEqual(ranked, [("/x/agents/boss/MEMORY.md", 0.9), ("/x/b.md", 0.4)])


class TestEvaluateMocked(unittest.TestCase):
    def _fake(self, mapping):
        def fn(python, mmrag, collection, query, env, top_k=eh.TOP_K):
            return list(mapping.get(collection, []))
        return fn

    def test_recall_fp_and_locked(self):
        eval_set = {
            "version": "1.1-locked", "locked_at_utc": "2026-06-17T00:24Z",
            "queries": [
                {"id": "q1", "tag": "VEC", "query": "find the rules",
                 "expected_sources": ["sa-creative-rules.md"],
                 "collection": "shared-cortex", "negative_control": False},
                {"id": "q2", "tag": "VEC", "query": "tokyo office",
                 "expected_sources": [], "collection": "any", "negative_control": True},
            ],
        }
        fake = self._fake({
            "shared-cortex": [("/x/shared/sa-creative-rules.md", 0.88), ("/x/other.md", 0.6)],
        })
        rep = eh.evaluate(eval_set, "py", "mmrag.py", {}, None, 0.5, query_fn=fake)
        self.assertFalse(rep["provisional"])  # locked
        agg = rep["aggregate"]["all7_merged"]
        self.assertEqual(agg["n_scored"], 1)
        self.assertEqual(agg["recall@5"], 1.0)
        self.assertEqual(agg["mrr"], 1.0)
        self.assertEqual(agg["false_positive_rate"], 1.0)  # control returned >=0.5
        # PROD_CURRENT control FP also fires (shared >=0.5 reachable on every path)
        self.assertEqual(rep["aggregate"]["prod_current"]["false_positive_rate"], 1.0)
        self.assertEqual(rep["misses"], [])               # nothing missed

    def test_miss_is_surfaced(self):
        eval_set = {
            "version": "1.1-locked", "locked_at_utc": "z",
            "queries": [
                {"id": "q1", "tag": "LEX", "query": "exact token",
                 "expected_sources": ["agents/coder/needle.md"],
                 "collection": "agent-coder", "negative_control": False},
            ],
        }
        fake = self._fake({c: [("/x/haystack.md", 0.7)] for c in eh.DEFAULT_COLLECTIONS})
        rep = eh.evaluate(eval_set, "py", "mmrag.py", {}, None, 0.5, query_fn=fake)
        self.assertEqual(rep["aggregate"]["all7_merged"]["recall@5"], 0.0)
        self.assertEqual(len(rep["misses"]), 1)            # surfaced loud
        self.assertEqual(rep["misses"][0]["id"], "q1")


class TestProdCurrentFidelity(unittest.TestCase):
    """codex Phase-0 exit-gate: PROD_CURRENT must match the real wrapper
    (src/bus/knowledge-base.ts:158-224) — shared-first concat, threshold-filtered,
    NO global re-sort — and therefore DIFFER from the merged ranking whenever an
    agent-private result outscores a shared one."""

    def test_prod_current_preserves_shared_first_vs_merged(self):
        by_col = {
            "shared-cortex": [("/x/shared/lo.md", 0.6)],
            "agent-coder": [("/x/agents/coder/hi.md", 0.9)],
        }
        pc = eh.prod_current_ranked(by_col, "agent-coder", "shared-cortex", 0.5)
        # shared FIRST even though its sim (0.6) is LOWER than the agent hit (0.9)
        self.assertEqual([p for p, _ in pc],
                         ["/x/shared/lo.md", "/x/agents/coder/hi.md"])
        merged = eh.merge_ranked([by_col["shared-cortex"], by_col["agent-coder"]])
        # merged sorts by similarity -> agent hit ranks first
        self.assertEqual([p for p, _ in merged],
                         ["/x/agents/coder/hi.md", "/x/shared/lo.md"])
        # the two views genuinely differ (the whole point of the fix)
        self.assertNotEqual([p for p, _ in pc], [p for p, _ in merged])

    def test_prod_current_threshold_filter_and_first_seen_dedup(self):
        by_col = {
            "shared-cortex": [("/x/a.md", 0.7), ("/x/below.md", 0.3), ("/x/dup.md", 0.55)],
            "agent-coder": [("/x/dup.md", 0.8), ("/x/b.md", 0.51)],
        }
        pc = eh.prod_current_ranked(by_col, "agent-coder", "shared-cortex", 0.5)
        # below-threshold (0.3) dropped; dup keeps its FIRST (shared) occurrence; shared-first
        self.assertEqual([p for p, _ in pc], ["/x/a.md", "/x/dup.md", "/x/b.md"])
        # dup retains the shared similarity (0.55), not the agent's higher 0.8
        self.assertEqual(dict(pc)["/x/dup.md"], 0.55)

    def test_prod_current_shared_only_for_shared_collection(self):
        by_col = {
            "shared-cortex": [("/x/s.md", 0.8)],
            "agent-coder": [("/x/a.md", 0.9)],
        }
        pc = eh.prod_current_ranked(by_col, "shared-cortex", "shared-cortex", 0.5)
        self.assertEqual([p for p, _ in pc], ["/x/s.md"])  # no agent path for shared queries

    def test_prod_current_fp_any_control_across_paths(self):
        cols = ["shared-cortex", "agent-coder", "agent-boss"]
        clean = {"shared-cortex": [("/x/a.md", 0.3)], "agent-coder": [("/x/b.md", 0.2)], "agent-boss": []}
        self.assertFalse(eh.prod_current_fp(clean, "any", cols, "shared-cortex", 0.5))
        # a confident match on ANY single agent path is an FP for an 'any' control
        hit = dict(clean, **{"agent-boss": [("/x/c.md", 0.7)]})
        self.assertTrue(eh.prod_current_fp(hit, "any", cols, "shared-cortex", 0.5))

    def test_prod_current_fp_agent_control_is_shared_or_that_agent(self):
        cols = ["shared-cortex", "agent-coder", "agent-boss"]
        by_col = {"shared-cortex": [("/x/a.md", 0.2)], "agent-coder": [("/x/b.md", 0.6)], "agent-boss": [("/x/c.md", 0.9)]}
        # agent-coder control: FP from its own confident hit (boss is NOT on this path)
        self.assertTrue(eh.prod_current_fp(by_col, "agent-coder", cols, "shared-cortex", 0.5))
        # a control routed at an agent with no confident hit on shared OR itself = no FP,
        # even though a DIFFERENT agent (boss) has one
        quiet = {"shared-cortex": [("/x/a.md", 0.2)], "agent-coder": [("/x/b.md", 0.4)], "agent-boss": [("/x/c.md", 0.9)]}
        self.assertFalse(eh.prod_current_fp(quiet, "agent-coder", cols, "shared-cortex", 0.5))


class TestFixARowLevel(unittest.TestCase):
    """Phase-1 Fix A: ROW-LEVEL no-dedup production-faithful A/B
    (flag_off_rows = shared-first concat; flag_on_rows = merge-by-score)."""

    def test_sort_by_score_stable_ties_keep_order_and_no_dedup(self):
        rows = [("/x/shared1.md", 0.5), ("/x/agent1.md", 0.5),
                ("/x/dup.md", 0.4), ("/x/hi.md", 0.9), ("/x/dup.md", 0.8)]
        out = eh.sort_by_score_stable(rows)
        self.assertEqual([p for p, _ in out],
                         ["/x/hi.md", "/x/dup.md", "/x/shared1.md", "/x/agent1.md", "/x/dup.md"])
        self.assertEqual(len(out), 5)  # no dedup: dup stays twice

    def test_flag_off_is_shared_first_concat_no_sort(self):
        by_col = {
            "shared-cortex": [("/x/s_lo.md", 0.6), ("/x/below.md", 0.3)],
            "agent-coder": [("/x/a_hi.md", 0.9)],
        }
        off = eh.fix_a_rows(by_col, "agent-coder", "shared-cortex", 0.5, merge=False)
        # below-threshold dropped; shared FIRST, agent appended, NO sort
        self.assertEqual([p for p, _ in off], ["/x/s_lo.md", "/x/a_hi.md"])

    def test_flag_on_sorts_by_score_agent_above_shared(self):
        by_col = {"shared-cortex": [("/x/s_lo.md", 0.6)], "agent-coder": [("/x/a_hi.md", 0.9)]}
        on = eh.fix_a_rows(by_col, "agent-coder", "shared-cortex", 0.5, merge=True)
        self.assertEqual([p for p, _ in on], ["/x/a_hi.md", "/x/s_lo.md"])

    def test_flag_on_no_dedup_preserves_duplicate_rows(self):
        by_col = {
            "shared-cortex": [("/x/dup.md", 0.7)],
            "agent-coder": [("/x/dup.md", 0.8), ("/x/b.md", 0.51)],
        }
        on = eh.fix_a_rows(by_col, "agent-coder", "shared-cortex", 0.5, merge=True)
        self.assertEqual([p for p, _ in on], ["/x/dup.md", "/x/dup.md", "/x/b.md"])
        self.assertEqual([s for _, s in on], [0.8, 0.7, 0.51])  # both dup rows kept

    def test_recall_lift_off_vs_on_via_evaluate(self):
        # Agent answer buried below 6 shared rows: OFF misses @5, ON recovers @5.
        shared_rows = [("/x/shared/s%d.md" % i, 0.70 - i * 0.01) for i in range(6)]  # 6 shared >=0.5
        eval_set = {
            "version": "1.1-locked", "locked_at_utc": "z",
            "queries": [
                {"id": "q1", "tag": "VEC", "query": "agent answer",
                 "expected_sources": ["agent-coder/answer.md"],
                 "collection": "agent-coder", "negative_control": False},
            ],
        }

        def fake(python, mmrag, collection, query, env, top_k=eh.TOP_K):
            if collection == "shared-cortex":
                return list(shared_rows)
            if collection == "agent-coder":
                return [("/x/agent-coder/answer.md", 0.95)]
            return []

        rep = eh.evaluate(eval_set, "py", "mmrag.py", {}, None, 0.5, query_fn=fake)
        off = rep["aggregate"]["flag_off_rows"]
        on = rep["aggregate"]["flag_on_rows"]
        self.assertEqual(off["recall@5"], 0.0)   # answer is row 7, missed @5
        self.assertEqual(off["recall@20"], 1.0)  # but retrievable @20
        self.assertEqual(on["recall@5"], 1.0)    # merged: answer (0.95) is row 1
        self.assertEqual(on["mrr"], 1.0)

    def test_control_fp_reuses_reachable_path_check_for_both_flags(self):
        eval_set = {
            "version": "1.1-locked", "locked_at_utc": "z",
            "queries": [
                {"id": "c1", "tag": "VEC", "query": "should not match",
                 "expected_sources": [], "collection": "any", "negative_control": True},
            ],
        }

        def fake(python, mmrag, collection, query, env, top_k=eh.TOP_K):
            return [("/x/agent-boss/x.md", 0.7)] if collection == "agent-boss" else []

        rep = eh.evaluate(eval_set, "py", "mmrag.py", {}, None, 0.5, query_fn=fake)
        # a confident hit on ANY reachable path is an FP for both flag states
        self.assertEqual(rep["aggregate"]["flag_off_rows"]["false_positive_rate"], 1.0)
        self.assertEqual(rep["aggregate"]["flag_on_rows"]["false_positive_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
