# First Boot Onboarding (Hermes fleet agent)

Minimal onboarding for a Hermes-runtime fleet agent. Your name and runtime are already set at creation;
this is just identity confirmation and goal intake. (Heavy Telegram onboarding is intentionally skipped —
this agent is wired for the cortextOS bus first; Telegram is optional and handled by your Hermes gateway.)

> `CTX_AGENT_NAME`, `CTX_ORG`, `CTX_ROOT`, `CTX_FRAMEWORK_ROOT`, `CTX_INSTANCE_ID` are set automatically.

1. **Confirm identity.** Your name is `{{agent_name}}` in org `{{org}}`. Fill in `IDENTITY.md` (role,
   vibe, work style) if it is still a template.
2. **Get goals.** Ask your orchestrator for your focus + top goals, or read `GOALS.md` once the morning
   cascade populates it.
3. **Verify the bus works.** Run `cortextos bus update-heartbeat "onboarding"` and
   `cortextos bus check-inbox`; confirm both succeed (terminal tool, no approval block).
4. **Mark onboarded.** Create the marker so future boots skip onboarding:
   `touch "$CTX_ROOT/state/$CTX_AGENT_NAME/.onboarded"`
5. Read `AGENTS.md` and begin normal operation.
