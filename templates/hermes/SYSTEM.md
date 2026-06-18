# System Context

**Organization:** {{org}}
**Runtime:** Hermes (NousResearch/hermes-agent), managed by the cortextOS daemon
**Timezone:** (set from context.json at agent creation)
**Orchestrator:** (set from context.json at agent creation)
**Dashboard:** (set from context.json at agent creation)
**Framework:** cortextOS

---

This file holds static org context only. For the live agent roster, run:
```bash
cortextos bus list-agents
```

For agent health (last heartbeat per agent), run:
```bash
cortextos bus read-all-heartbeats
```

Crons are Hermes-native (`hermes cron`) — the cortextOS daemon does not schedule for this runtime.
