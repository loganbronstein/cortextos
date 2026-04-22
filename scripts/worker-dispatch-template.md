# Worker Dispatch Prompt Template

> Canonical template for the prompt body given to a spawned worker session
> (`cortextos spawn-worker`, M2C1 worker, or inline subagent). This is the
> structure every dispatcher should follow. Sections marked REQUIRED must
> appear in every dispatch. Sections marked OPTIONAL are situational.

---

## 1. Header (REQUIRED)

```
Bounded worker. Task: <one-line summary>. Full spec in bus task <task_id>.

Working dir: <absolute path>
Branch: <feature branch name>

Read the task description in full: cat <task-json-path> | jq -r .description
```

## 2. Deliverables (REQUIRED)

Enumerate exact files / artifacts / outputs. No prose goals. Every deliverable is testable or greppable.

```
DELIVERABLES:
1. <file-or-artifact>: <what-changes>
2. ...
```

## 3. Hard Rules (REQUIRED)

Scope boundaries, style constraints, compatibility requirements, review bar, failure modes to avoid.

```
HARD RULES:
- Scope: <files / dirs the worker is allowed to touch>
- <compat constraint, e.g. macOS bash 3.2>
- Callsite verification on any new symbol (count >= 1 outside tests)
- Adversarial review subagent on the DIFF
- codex:rescue final pass
- PR flow: push + gh pr create + merge to local main
```

## 4. Plan Review (REQUIRED — added 2026-04-22, from Bradley Banner)

**Before touching any file**, the worker must run a plan review. This is a
pre-code adversarial pass on the plan itself. It catches wrong-direction work
before code is written, which is cheaper than catching it in post-code review.

### Trivial-task exception

If the task is trivial — **1-2 line fix, typo correction, doc micro-edit, or
dependency version bump with no API surface change** — skip plan review and go
straight to Execute + standard adversarial. Default to "not trivial" when in
doubt; the incremental cost of a plan review on a small task is small, the
cost of shipping the wrong thing on a "trivial" task that was actually
architectural is large.

**Blast-radius denylist (trivial never applies here, regardless of diff size):**
any touch to `config/`, `migrations/`, `infra/`, `secrets/`, `auth/`, `crypto/`,
`iam/`, `billing/`, `*.sql`, `*.tf`, anything under a `deploy/` tree, or a
feature-flag file forces plan review. A 1-line change to a rate limit, a
feature-flag default, or a crypto constant is not trivial.

### Panel failure modes

- **Quorum:** 8 of 10 personas must return a review. Security and Data Integrity
  are mandatory; if either is missing, the panel is invalid and the task blocks.
- **Timeout:** 2 min wall clock per persona (tunable). One retry on timeout;
  a second timeout counts as "no signal, low confidence" against quorum.
- **Fail-closed:** quorum not met = execute blocks. The rule is not theater.

### Deadlock ranking

When two personas give contradictory advice, the moderator picks by this axis
order: **data integrity > security > availability > performance > UX >
maintainability**. The moderator must name the axis that won and log why. A
same-tier deadlock escalates to a human, not moderator discretion.

### Moderator attribution

Every MUST / SHOULD / NICE item must cite the persona(s) that raised it.
Moderator-originated items (no persona adopted them) are flagged as such and
require either a persona to adopt the concern or a human sign-off before they
count. This closes the "moderator invents new MUSTs" hole.

### MUST-FIX reproducer rule

A MUST-FIX must name a concrete failure scenario (input, state,
expected-vs-actual) or a test that would catch it. A MUST without a reproducer
downgrades to SHOULD. Kills the rubber-stamp failure mode where 10 personas
pattern-match generic security / perf concerns without a real scenario behind
them.

### Revision loop cap

At most 2 revision rounds. Round 3 escalates to a human, or ships with
unresolved items logged as "known risks" in the PR body. This prevents a
stubborn persona or flaky moderator from burning unbounded tokens.

### Plan review steps

1. **Verbalize understanding.** In 2-4 sentences, restate the task in your
   own words. Call out ambiguities. If multiple interpretations exist, name
   them instead of silently picking one.
2. **Draft a plan.** List: (a) numbered steps, (b) exact file list with what
   changes in each, (c) acceptance criteria (how you will know it is done).
3. **Spawn a 10-persona reviewer panel.** Run ten independent reviewer passes
   on the plan (not the code). Each persona reads the plan from their
   specialty's lens and reports: "what would fail", "what is missing",
   "what is the smallest change that covers this concern". Default panel:
     1. **Security** — attack surface, secrets, authz, injection
     2. **Performance** — N+1, O(n^2), hot path, memory
     3. **UX** — user-visible behavior, error messages, reversibility
     4. **Data integrity** — migrations, backfills, invariants, races
     5. **Architecture** — coupling, boundary violations, abstraction fit
     6. **Maintainability** — future readers, naming, dead branches
     7. **Testing** — what the plan leaves untested, test-to-change ratio
     8. **Product fit** — does this actually solve the user's stated need
     9. **Devops / deploy** — rollout, rollback, feature flag, blast radius
    10. **Skeptic** — is the premise wrong, is there a simpler alternative,
        is this task worth doing at all
4. **Moderator consolidation.** One pass reads the ten outputs, dedupes
   concerns, and produces a single ordered edit list. Moderator must
   explicitly mark: `MUST FIX`, `SHOULD FIX`, `NICE TO HAVE`. On deadlock
   (two personas contradict), the moderator picks the safer direction and
   logs the tradeoff in the revised plan.
5. **Revise the plan.** Apply `MUST FIX` and as many `SHOULD FIX` as are
   cheap. Re-run the panel only if the revision changed the approach, not if
   it only tightened details.
6. **Proceed to Execute** with the revised plan.

### Avoiding the "just call it trivial" incentive

Worker prompts that consistently mark tasks as trivial to skip plan review
are an anti-pattern. Reviewers (codex:rescue, adversarial pass) should flag
any PR that touched 3+ files or introduced new symbols but skipped plan
review. The dispatcher template keeps the trivial exception narrow on
purpose: line count, not judgment.

### Honest cost estimate

Plan review costs ~10 reviewer passes plus one moderator pass per non-trivial
task. Empirically: a full reject-and-rebuild loop (wrong direction caught
post-merge, revert, rework) costs 3x to 5x a plan review. The breakeven is
roughly "plan review pays for itself if it prevents one wrong-direction PR
out of every five". Bradley Banner's report on his own fleet: closer to one
in three.

**Measurement plan (so the rule can kill itself if it is not working):**
"Wrong PR" for this metric = reverted within 7 days OR required a follow-up
fix PR within 48h OR caused a P0/P1 incident. Analyst logs plan-review cost
per task (tokens in + tokens out, reviewer count, revision rounds) and the
downstream outcome of each PR. Ratio reviewed at month 3. If the rule has
not hit breakeven, rule kills itself and goes back to post-code-only
adversarial review.

## 5. Execute (REQUIRED)

Implement the revised, panel-approved plan. Keep diffs tight. Match existing
patterns. Do not "improve" adjacent code. Every changed line traces back to
an acceptance criterion in the plan.

## 6. Post-Execution Review (REQUIRED)

- Full test suite pass (unit + integration as applicable).
- Adversarial review subagent attacks the diff. Fix findings.
- Callsite verification: `grep` every new symbol; count outside tests must be
  >= 1. If 0, it is dead code.
- `codex:rescue` final pass.
- Merge per the dispatch's PR flow (feature branch -> origin -> PR -> merge).

## 7. Reporting (REQUIRED)

When done, send a final summary to the dispatching agent via bus:

```
cortextos bus send-message <dispatcher> normal \
  "Done: <task_id>. PR: <url>. Plan-review MUST-FIX count: <n>. Adversarial findings: <n>."
```

## 8. Bounded Scope Clock (REQUIRED)

Every dispatch has a hard wall clock. When hit: send interim results, stop.

```
Bounded <N>min.
If you hit a rate limit: send interim + stop.
```

---

## Worked example — trivial path

**Task:** fix typo "recieve" -> "receive" in `README.md`.
**Plan review verdict:** skip (1-line doc edit, no API surface).
**Execute:** one-line fix, commit, PR, merge.
**Post-exec:** adversarial pass is a no-op on a typo; callsite check N/A.

## Worked example — non-trivial path

**Task:** add a daemon cron that silently resets agent context at 85% usage.
**Plan review verdict:** run full panel.
**Sample panel flags:**
- Security: "reset at 85% leaks thresholds via logs — log at debug not info"
- Data integrity: "silent reset during an in-flight task risks losing the task handle — gate on idle"
- Skeptic: "is 85% even the right number, or should it be adaptive"
**Moderator output:** MUST FIX (gate on idle), SHOULD FIX (log level debug),
NICE TO HAVE (adaptive threshold — punt to v2).
**Revised plan:** as above, threshold stays 85% for v1, feature-flag for v2 tuning.
**Execute / post-exec:** per standard flow.
