---
branch: <feat/your-branch-here>
task: <task_id or "none">
created: <ISO-8601 UTC>
---

# Plan Review: <one-line title>

## Goal

<2-3 sentences describing what success looks like for this branch.>

## Plan

<bullets covering the approach, files touched, dependencies, and acceptance criteria>

- File 1: ...
- File 2: ...
- Test plan: ...
- Acceptance: ...

## Reviewer Panel (10 personas)

Each persona reviews the plan above and votes PASS / FAIL. Security and
DataIntegrity are mandatory and must be PASS.

| Persona | Verdict | Notes |
|---|---|---|
| Security | PASS | <input validation, auth, secrets exposure considered> |
| DataIntegrity | PASS | <migrations safe, no destructive ops, FK invariants hold> |
| Performance | PASS | <hot paths, allocations, query complexity considered> |
| UX | PASS | <user-facing surfaces, error states, accessibility> |
| Architecture | PASS | <module boundaries, contracts, single-responsibility> |
| Maintainability | PASS | <names, comments where why is non-obvious, no dead code> |
| Testing | PASS | <unit + integration coverage of the new symbols> |
| ProductFit | PASS | <ties to a real Logan goal or business need> |
| DevOps | PASS | <deploy path, rollback, env vars, no breaking changes> |
| Skeptic | PASS | <what could go wrong that the other personas missed?> |

## Verdict

QUORUM: PASS (10/10)

## Callsite verification

New symbols introduced by this branch and the production callsite that
proves they are not dead code:

| Symbol | Production callsite |
|---|---|
| `someFunction()` | `src/path/to/caller.ts:123` |

## Notes

<Anything else the reviewer panel needs to know — open questions, deferred
work, dependencies on other branches, etc.>
