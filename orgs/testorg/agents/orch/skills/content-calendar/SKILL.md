---
name: content-calendar
description: "Daily content calendar management. Populate weekly slots, review daily readiness, advance slot status after filming. Integrates with morning-review and worker research dispatch."
triggers: ["content calendar", "content plan", "scripts ready", "populate calendar", "filming", "advance slots"]
---

# Content Calendar

Manages the daily content calendar at `../../../../content-calendar.json` (relative to this file: `orgs/testorg/content-calendar.json`).

**Calendar path:** `$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/content-calendar.json`

---

## Slot Status Lifecycle

```
empty → researched → scripted → filmed → posted
```

- **empty** — slot exists, no topic yet
- **researched** — topic + outline filled by worker
- **scripted** — full hook/body/CTA written, ready to film
- **filmed** — James filmed it
- **posted** — published to platform

---

## Workflow: populate

**When to run:** Sunday evening, or when a new week starts with empty slots.

### Steps

1. **Read org context**
   ```bash
   cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/knowledge.md
   cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/brand-voice.md
   cat GOALS.md
   ```

2. **Read meta from calendar**
   ```bash
   cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/content-calendar.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['meta'], indent=2))"
   ```

3. **Generate weekly themes** (7 days, one theme per day)
   Based on: niche, goals, variety (don't repeat themes week-over-week).
   Example themes: "AI automation", "productivity hacks", "founder mindset", "tool reviews", "behind the scenes"

4. **Write themes to calendar**
   Update each day's `theme` field in `content-calendar.json`. Leave slots as `empty` — worker fills topics nightly.

5. **Log and notify**
   ```bash
   cortextos bus log-event action content_calendar_populated info --meta '{"week_of":"<date>","themes_set":7}'
   cortextos bus send-telegram 7940429114 "Content calendar populated for week of <date>. 7 themes set. Worker will research topics nightly."
   ```

---

## Workflow: review

**When to run:** During morning-review (Phase 5), or on demand.

### Steps

1. **Read today's slots**
   ```bash
   TODAY=$(date +%Y-%m-%d)
   cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/content-calendar.json | python3 -c "
   import json, sys, os
   d = json.load(sys.stdin)
   today = os.environ.get('TODAY', '')
   day = d['days'].get(today, {})
   slots = day.get('slots', [])
   for s in slots:
       print(f\"Slot {s['id']}: {s['status']} — {s.get('topic','(no topic)')}\")
   skool = day.get('skool_post', {})
   print(f\"Skool: {skool.get('status','empty')} — {skool.get('topic','(no topic)')}\")
   "
   ```

2. **Evaluate readiness**

   | State | Action |
   |-------|--------|
   | All 3 scripted | ✅ Ready to film. Report in morning briefing. |
   | Some researched, some empty | ⚠️ Dispatch worker urgently to script remaining slots. |
   | All empty | 🚨 Dispatch worker immediately. Flag in briefing. |

3. **Dispatch worker if needed**
   ```bash
   TASK_ID=$(cortextos bus create-task "Script content slots for today" "Write full hook/body/CTA scripts for today's content calendar slots. Read $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/content-calendar.json, fill today's slots, update status to scripted." worker high)
   cortextos bus update-task "$TASK_ID" in_progress
   cortextos bus send-message worker high "Content calendar task: script today's slots. Task ID: $TASK_ID. Read orgs/$CTX_ORG/content-calendar.json and fill today ($TODAY) slots with full scripts. Update status to scripted when done."
   cortextos bus log-event action task_dispatched info --meta "{\"to\":\"worker\",\"task\":\"script content slots\"}"
   ```

4. **Return summary string** (for use in morning-review message):
   ```
   Content: X/3 scripted | Y/3 researched | Z empty | Skool: [status]
   ```

---

## Workflow: advance

**When to run:** After James's filming window (10:00 AM), or when he confirms filming done.

### Steps

1. **Read today's scripted slots**
2. **Mark as filmed**
   ```bash
   TODAY=$(date +%Y-%m-%d)
   python3 << 'PYEOF'
   import json
   path = "$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/content-calendar.json"
   with open(path) as f:
       d = json.load(f)
   today = "$TODAY"
   if today in d['days']:
       for slot in d['days'][today]['slots']:
           if slot['status'] == 'scripted':
               slot['status'] = 'filmed'
   with open(path, 'w') as f:
       json.dump(d, f, indent=2)
   print("Advanced scripted → filmed")
   PYEOF
   ```

3. **Log event**
   ```bash
   cortextos bus log-event action content_filmed info --meta '{"date":"'$TODAY'","slots":3}'
   ```

---

## Nightly Research Dispatch

**Called by:** evening-review skill, or heartbeat if slots are empty.

```bash
TOMORROW=$(date -v+1d +%Y-%m-%d 2>/dev/null || date -d 'tomorrow' +%Y-%m-%d)
TASK_ID=$(cortextos bus create-task "Research content topics for $TOMORROW" "Read orgs/$CTX_ORG/content-calendar.json and orgs/$CTX_ORG/knowledge.md. Research 3 trending topics in the org niche. Fill tomorrow's slots with topic + outline. Update status to 'researched'." worker normal)
cortextos bus send-message worker normal "Nightly content research task. Task ID: $TASK_ID. Research 3 trending topics for tomorrow ($TOMORROW) and fill content-calendar.json slots. Update status to researched."
cortextos bus log-event action task_dispatched info --meta "{\"to\":\"worker\",\"task\":\"nightly content research\",\"date\":\"$TOMORROW\"}"
```

---

## Manual Commands

James can trigger via Telegram:

| Command | Action |
|---------|--------|
| `populate calendar` | Run populate workflow for current week |
| `content status` | Run review workflow, report to Telegram |
| `filming done` | Run advance workflow, mark today filmed |
| `research tomorrow` | Dispatch worker for nightly research now |
