#!/usr/bin/env python3
"""Mocked unit tests for the Phase-2 hybrid BM25 FTS5 sidecar (mmrag.py).

Pure stdlib (unittest + sqlite3 FTS5); no Chroma / Gemini / network — uses a temp
FTS DB and a fake collection object mirroring Chroma's `.get(include=...)` shape.
Run:  python3 -m unittest test_hybrid   (from knowledge-base/scripts/)
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mmrag  # noqa: E402


class FakeCollection:
    """Mimics chromadb collection.get(include=['documents','metadatas'])."""
    def __init__(self, rows):  # rows = [(doc_id, text, metadata), ...]
        self._rows = rows

    def get(self, include=None):
        return {
            "ids": [r[0] for r in self._rows],
            "documents": [r[1] for r in self._rows],
            "metadatas": [r[2] for r in self._rows],
        }


class TestFtsSanitize(unittest.TestCase):
    def test_tokenizes_and_quotes(self):
        self.assertEqual(mmrag.fts_sanitize_query("Aleric Heck"), '"aleric" OR "heck"')

    def test_strips_operators_quotes_hyphens_punctuation(self):
        # Arbitrary punctuation / FTS5 operators must not survive as raw syntax.
        out = mmrag.fts_sanitize_query('AdOutreach: "the-quick" (fox) AND *')
        for bad in ['(', ')', ':', '*']:
            self.assertNotIn(bad, out)
        for tok in ['"adoutreach"', '"the"', '"quick"', '"fox"', '"and"']:
            self.assertIn(tok, out)

    def test_empty_input(self):
        self.assertEqual(mmrag.fts_sanitize_query("   !@#  "), "")
        self.assertEqual(mmrag.fts_sanitize_query(""), "")
        self.assertEqual(mmrag.fts_sanitize_query(None), "")


class TestFtsSidecar(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "raw-v1.db")
        self.conn = mmrag.fts_connect(self.db)

    def tearDown(self):
        self.conn.close()

    def _sync(self, name, rows):
        return mmrag.fts_sync_collection(self.conn, FakeCollection(rows), name)

    def test_sync_and_bm25_ranks_lexical_match_first(self):
        rows = [
            ("d1", "Aleric Heck AdOutreach YouTube ads strategy",
             {"source": "/x/a.md", "type": "text", "chunk_index": 0, "filename": "a.md"}),
            ("d2", "generic note about pricing and margins",
             {"source": "/x/b.md", "type": "text", "chunk_index": 0, "filename": "b.md"}),
        ]
        self.assertEqual(self._sync("agent-scribe", rows), 2)
        hits = mmrag.fts_search(self.conn, "agent-scribe", "Aleric Heck AdOutreach", 5)
        self.assertTrue(hits)
        self.assertEqual(hits[0][0], "d1")  # the exact-token doc ranks first (the q07 case)
        self.assertEqual(hits[0][1], 0)     # 0-based rank position for RRF

    def test_search_scoped_to_collection(self):
        self._sync("agent-scribe", [("d1", "aleric heck", {"type": "text"})])
        self._sync("agent-coder", [("d2", "aleric heck", {"type": "text"})])
        hits = mmrag.fts_search(self.conn, "agent-scribe", "aleric", 5)
        self.assertEqual([h[0] for h in hits], ["d1"])  # coder's d2 excluded

    def test_resync_replaces_collection_rows(self):
        self._sync("c", [("d1", "alpha unique", {"type": "text"})])
        self._sync("c", [("d2", "beta unique", {"type": "text"})])  # resync = delete+insert
        self.assertFalse(mmrag.fts_search(self.conn, "c", "alpha", 5))
        self.assertTrue(mmrag.fts_search(self.conn, "c", "beta", 5))

    def test_delete_docs_removes_only_those(self):
        self._sync("c", [("d1", "alpha note", {"type": "text"}),
                         ("d2", "alpha other", {"type": "text"})])
        mmrag.fts_delete_docs(self.conn, "c", ["d1"])
        self.assertEqual([h[0] for h in mmrag.fts_search(self.conn, "c", "alpha", 5)], ["d2"])

    def test_type_filter_applies_to_bm25(self):
        self._sync("c", [("d1", "alpha", {"type": "text"}),
                         ("d2", "alpha", {"type": "image"})])
        hits = mmrag.fts_search(self.conn, "c", "alpha", 5, type_filter="image")
        self.assertEqual([h[0] for h in hits], ["d2"])

    def test_empty_query_returns_no_results(self):
        self._sync("c", [("d1", "alpha", {"type": "text"})])
        self.assertEqual(mmrag.fts_search(self.conn, "c", "!@# $%", 5), [])

    def test_skips_empty_text_chunks(self):
        n = self._sync("c", [("d1", "", {"type": "text"}),
                             ("d2", "real text here", {"type": "text"})])
        self.assertEqual(n, 1)

    def test_punctuation_query_does_not_raise(self):
        self._sync("c", [("d1", "the quick brown fox", {"type": "text"})])
        # a hyphen/quote/operator-laden query must execute, not throw FTS5 syntax errors
        try:
            mmrag.fts_search(self.conn, "c", 'quick-brown "fox" AND (cat) OR *', 5)
        except Exception as e:  # pragma: no cover
            self.fail(f"fts_search raised on punctuation query: {e}")


class TestRRFFuse(unittest.TestCase):
    """Phase-2 RRF fusion (hybrid_fuse): candidate OR-inclusion, BM25 boost, hydration."""

    def test_cosine(self):
        self.assertAlmostEqual(mmrag._cosine([1, 0], [1, 0]), 1.0)
        self.assertAlmostEqual(mmrag._cosine([1, 0], [0, 1]), 0.0)
        self.assertEqual(mmrag._cosine([], [1.0]), 0.0)

    def _vec(self, doc_id, sim, vrank):
        return {"id": doc_id, "content": doc_id, "similarity": sim, "metadata": {}, "vrank": vrank}

    def test_bm25_boost_surfaces_buried_vector_hit(self):
        # The answer is vrank 5 (buried under 5 shared docs) but BM25 ranks it #1 -> RRF floats it up.
        vec = [self._vec(f"s{i}", 0.60 - i * 0.01, i) for i in range(5)]
        vec.append(self._vec("ans", 0.55, 5))
        fused = mmrag.hybrid_fuse(vec, [("ans", 0)], 0.5, None, "c", [1.0])
        self.assertEqual(fused[0]["id"], "ans")
        self.assertIn("rank_score", fused[0])
        self.assertGreater(fused[0]["rank_score"], fused[1]["rank_score"])

    def test_bm25_hit_below_cosine_floor_is_included(self):
        # 'lex' cosine 0.2 (< 0.5 floor) but a BM25 hit -> candidate (the q07 mechanism).
        vec = [self._vec("v1", 0.7, 0), self._vec("lex", 0.2, 1)]
        fused = mmrag.hybrid_fuse(vec, [("lex", 0)], 0.5, None, "c", [1.0])
        ids = [r["id"] for r in fused]
        self.assertIn("lex", ids)
        self.assertIn("v1", ids)

    def test_vector_below_floor_and_not_in_bm25_excluded(self):
        vec = [self._vec("v1", 0.7, 0), self._vec("low", 0.3, 1)]
        fused = mmrag.hybrid_fuse(vec, [], 0.5, None, "c", [1.0])
        self.assertEqual([r["id"] for r in fused], ["v1"])

    def test_fts_only_hit_hydrated_from_chroma(self):
        class HydrateCol:
            def get(self, ids=None, include=None):
                return {"ids": ["ftsonly"], "documents": ["hydrated text"],
                        "metadatas": [{"source": "/x/h.md"}], "embeddings": [[1.0, 0.0]]}
        vec = [self._vec("v1", 0.7, 0)]
        fused = mmrag.hybrid_fuse(vec, [("ftsonly", 0)], 0.5, HydrateCol(), "c", [1.0, 0.0])
        row = next((r for r in fused if r["id"] == "ftsonly"), None)
        self.assertIsNotNone(row)
        self.assertEqual(row["content"], "hydrated text")
        self.assertAlmostEqual(row["similarity"], 1.0)  # cosine([1,0],[1,0]) hydrated for display


if __name__ == "__main__":
    unittest.main()
