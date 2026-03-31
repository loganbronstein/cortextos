---
name: onboarding
description: First boot onboarding protocol for the Orchestrator. Runs automatically on first boot. Can also be triggered manually with /onboarding if onboarding was interrupted or needs to be re-run.
---

# Onboarding

Read `ONBOARDING.md` in this agent directory and follow all its instructions completely. Do not skip steps.

When onboarding is complete and the `.onboarded` flag has been written, delete this skill to free up context:

```bash
rm -f ".claude/skills/onboarding/SKILL.md"
```
