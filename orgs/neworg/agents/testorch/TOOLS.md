# Bus Script Reference - COMPLETE TOOL INVENTORY

Every tool you have. Use them or the system cannot see your work.
All scripts live at `$CTX_FRAMEWORK_ROOT/bus/`. Always invoke with `cortextos bus <script>`.

---

## Tasks

### create-task.sh
Create a new task in the system. Tasks are visible on the dashboard.

```bash
cortextos bus create-task "<title>" "<description>" [assignee] [priority] [project]
```

- **title** (required): Short task name
- **description** (required): What needs to be done - be specific
- **assignee** (optional): Agent name. Defaults to $CTX_AGENT_NAME
- **priority** (optional): `critical` | `high` | `normal` | `low`. Defaults to `normal`
- **project** (optional): Project grouping

Example:
```bash
cortextos bus create-task "<task title>" "<task description>" <agent-name> <priority> <project>
```

### update-task.sh
Update a task's status. Use this when you START working on something.

```bash
cortextos bus update-task "<task_id>" <status> [note]
```

- **task_id** (required): The task ID from create-task or list-tasks
- **status** (required): `pending` | `in_progress` | `blocked` | `completed`
- **note** (optional): Context on the update

Example:
```bash
cortextos bus update-task "task_abc123" in_progress "Starting implementation now"
```

### complete-task.sh
Mark a task as completed with a summary. Use this when DONE, not when starting.

```bash
cortextos bus complete-task "<task_id>" "<summary>"
```

- **task_id** (required): The task ID
- **summary** (required): What was produced/accomplished

Example:
```bash
cortextos bus complete-task "task_abc123" "Deployed landing page to production. URL: https://site.com"
```

### list-tasks.sh
List and filter tasks. Use during every heartbeat to check your queue.

```bash
cortextos bus list-tasks [--status S] [--agent A] [--priority P] [--all-orgs]
```

- **--status**: Filter by `pending` | `in_progress` | `blocked` | `completed`
- **--agent**: Filter by agent name
- **--priority**: Filter by `critical` | `high` | `normal` | `low`
- **--all-orgs**: Show tasks across all orgs

Example:
```bash
cortextos bus list-tasks --agent $CTX_AGENT_NAME --status pending
```

---

## Messages

### send-message.sh
Send a message to another agent. They will see it on their next inbox check.

```bash
cortextos bus send-message <target_agent> <priority> '<message_body>' [reply_to]
```

- **target_agent** (required): Target agent name
- **priority** (required): `critical` | `high` | `normal` | `low`
- **message_body** (required): The message content. Use single quotes around JSON or complex strings
- **reply_to** (optional): Message ID this is responding to

Example:
```bash
cortextos bus send-message <agent-name> high '{"action":"deploy","repo":"website","branch":"main"}'
```

### check-inbox.sh
Check for incoming messages from other agents. Run this EVERY heartbeat.

```bash
cortextos bus check-inbox
```

Returns a list of messages. Each has an ID you must ACK.

### ack-inbox.sh
Acknowledge a message. Un-ACK'd messages are re-delivered in 5 minutes.

```bash
cortextos bus ack-inbox "<message_id>"
```

Example:
```bash
cortextos bus ack-inbox "msg_xyz789"
```

---

## Events

### log-event.sh
Log a structured event. Events are the primary way the dashboard tracks your activity.
No events = you look dead. Log aggressively.

```bash
cortextos bus log-event <category> <event_name> <severity> '[json_payload]'
```

- **category** (required): `heartbeat` | `task` | `comms` | `error` | `system` | `work`
- **event_name** (required): Descriptive event name (e.g., `agent_heartbeat`, `task_completed`, `deploy_started`)
- **severity** (required): `info` | `warning` | `error` | `critical`
- **json_payload** (optional): Structured data as JSON string

Examples:
```bash
cortextos bus log-event heartbeat agent_heartbeat info '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus log-event task task_completed info '{"task_id":"task_abc123","summary":"Deployed site"}'
cortextos bus log-event error deploy_failed error '{"repo":"website","error":"build timeout"}'
cortextos bus log-event work research_complete info '{"topic":"competitor analysis","findings":3}'
```

---

## Heartbeat

### update-heartbeat.sh
Update your heartbeat timestamp and status. This is how the system knows you are alive.
If you do not call this, the dashboard shows you as DEAD.

```bash
cortextos bus update-heartbeat "<current_task_summary>"
```

- **current_task_summary** (required): 1 sentence describing what you are doing right now

Example:
```bash
cortextos bus update-heartbeat "WORKING ON: Implementing user auth for the dashboard"
```

---

## Approvals

### create-approval.sh
Request human approval before taking a high-stakes action. Required for: external comms, production deploys, data deletion, financial commitments.

```bash
cortextos bus create-approval "<title>" <category> "[context]"
```

- **title** (required): What you are requesting approval for
- **category** (required): `deploy` | `comms` | `financial` | `data` | `other`
- **context** (optional): Additional details to help the human decide

Example:
```bash
cortextos bus create-approval "Send cold outreach to 50 leads" comms "Draft email attached in task_abc123. Target list: SaaS founders."
```

### update-approval.sh
Resolve an approval request (typically called by the system after human responds via Telegram).

```bash
cortextos bus update-approval <approval_id> <approved|rejected> "[note]"
```

Example:
```bash
cortextos bus update-approval "appr_123" approved "User approved via Telegram"
```

---

## Telegram

### send-telegram.sh
Send a message to the user via Telegram. Use for urgent updates, approval requests, and status reports.
Do NOT spam. Reserve for things the user actually needs to see.

```bash
cortextos bus send-telegram <chat_id> "<message>"
```

- **chat_id** (required): Telegram chat ID (available in config)
- **message** (required): The message text. Supports basic Telegram markdown

Example:
```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "Task completed: Landing page deployed to production. URL: https://site.com"
```

### edit-message.sh
Edit an existing Telegram message (e.g., to update a status message in-place).

```bash
cortextos bus edit-message <chat_id> <message_id> "<new_text>" [reply_markup_json]
```

### answer-callback.sh
Answer a Telegram callback query to dismiss button loading state.

```bash
cortextos bus answer-callback <callback_query_id> [toast_text]
```

---

## Discovery

### list-agents.sh
Discover all agents in the system.

```bash
cortextos bus list-agents [--org <org>] [--format json|text] [--status running|all]
```

### list-skills.sh
List available skills for the current agent.

```bash
cortextos bus list-skills [--format text|json]
```

### read-all-heartbeats.sh
Aggregate all agent heartbeats into a single JSON object keyed by agent name.

```bash
cortextos bus read-all-heartbeats
```

---

## Fleet Health

### check-stale-tasks.sh
Find stale tasks: in_progress >2h, pending >24h, stale human tasks, overdue.

```bash
cortextos bus check-stale-tasks [--all-orgs]
```

### check-goal-staleness.sh
Check each agent's GOALS.md Updated timestamp. Flags goals older than threshold.

```bash
cortextos bus check-goal-staleness [--threshold DAYS] [--json]
```

### check-human-tasks.sh
Check for stale human-assigned tasks and send reminders.

```bash
cortextos bus check-human-tasks
```

### archive-tasks.sh
Archive completed tasks older than 7 days.

```bash
cortextos bus archive-tasks [--dry-run] [--all-orgs]
```

### notify-agent.sh
Send an urgent signal to another agent's fast-checker (bypasses normal inbox polling).

```bash
cortextos bus notify-agent <agent_name> "<message>"
```

### post-activity.sh
Post a message to the org's Telegram activity channel.

```bash
cortextos bus post-activity "<message>"
```

---

## Experiments (Theta Wave)

### create-experiment.sh
Create a new experiment proposal. For system-scope, auto-creates an approval.

```bash
cortextos bus create-experiment <metric_name> "<hypothesis>" [--surface <path>] [--direction higher|lower] [--window <duration>] [--measurement <cmd>]
```

### run-experiment.sh
Start running a proposed experiment.

```bash
cortextos bus run-experiment <experiment_id> [changes_description]
```

### evaluate-experiment.sh
Evaluate a running experiment and decide keep/discard.

```bash
cortextos bus evaluate-experiment <experiment_id> <measured_value> [--score <1-10>] [--justification "<text>"]
```

### list-experiments.sh
List experiments with filters.

```bash
cortextos bus list-experiments [--agent <name>] [--status <status>] [--metric <name>] [--limit <N>] [--json]
```

### gather-context.sh
Collect experiment context for hypothesis generation.

```bash
cortextos bus gather-context [--agent <name>] [--metric <name>] [--format json|markdown]
```

---

## Lifecycle

### self-restart.sh
Restart with `--continue` (preserves conversation history).

```bash
cortextos bus self-restart --reason "why"
```

### hard-restart.sh
Kill and relaunch (fresh session, no history).

```bash
cortextos bus hard-restart --reason "why"
```

### auto-commit.sh
Automatic daily snapshot of agent workspace changes. Local only, never pushes.

```bash
cortextos bus auto-commit [--dry-run]
```

### check-upstream.sh
Check for framework updates from the canonical repo.

```bash
cortextos bus check-upstream [--apply]
```

---

## Community Ecosystem

### browse-catalog.sh
Browse community catalog for skills, agents, or org templates.

```bash
cortextos bus browse-catalog [--type skill|agent|org] [--tag <tag>] [--search <query>]
```

### install-community-item.sh
Install a community catalog item.

```bash
cortextos bus install-community-item <item-name> [--dry-run]
```

### prepare-submission.sh
Prepare a skill/agent/org for community submission (PII scan + staging).

```bash
cortextos bus prepare-submission <type> <source-path> <item-name> [--dry-run]
```

### submit-community-item.sh
Submit a prepared item to the community catalog.

```bash
cortextos bus submit-community-item <item-name> <item-type> "<description>" [--dry-run]
```

---

## Quick Reference

| I need to...                      | Script                  |
|-----------------------------------|-------------------------|
| Prove I'm alive                   | `update-heartbeat.sh`   |
| Check for messages                | `check-inbox.sh`        |
| Confirm I read a message          | `ack-inbox.sh`          |
| Talk to another agent             | `send-message.sh`       |
| Create work                       | `create-task.sh`        |
| Show progress                     | `update-task.sh`        |
| Finish work                       | `complete-task.sh`      |
| See my queue                      | `list-tasks.sh`         |
| Leave a trail                     | `log-event.sh`          |
| Ask permission                    | `create-approval.sh`    |
| Alert the user                    | `send-telegram.sh`      |
| Edit a Telegram message           | `edit-message.sh`       |
| Post to activity channel          | `post-activity.sh`      |
| Urgently signal another agent     | `notify-agent.sh`       |
| Find all agents                   | `list-agents.sh`        |
| Find available skills             | `list-skills.sh`        |
| Check fleet heartbeats            | `read-all-heartbeats.sh`|
| Find stale tasks                  | `check-stale-tasks.sh`  |
| Find stale goals                  | `check-goal-staleness.sh`|
| Archive old tasks                 | `archive-tasks.sh`      |
| Run an experiment                 | `create-experiment.sh`  |
| Restart (keep history)            | `self-restart.sh`       |
| Restart (fresh)                   | `hard-restart.sh`       |
| Snapshot workspace                | `auto-commit.sh`        |
| Check for updates                 | `check-upstream.sh`     |


### Playwright (Browser Automation)
- **Binary**: `playwright` (Python)
- **Use for**: Scraping websites, browser-based automation
- **Chromium installed**: Yes (headless)
- **Usage**: Write Python scripts using `from playwright.sync_api import sync_playwright` or use Playwright MCP if configured
- **Env**: Service credentials available via environment variables if configured


### Peekaboo (macOS Desktop Automation)
- **Binary**: `peekaboo`
- **Use for**: Screenshot capture, UI clicking, typing, drag, window/app management, desktop automation
- **Permissions**: Screen Recording + Accessibility granted to tmux binary (launchd agents inherit via tmux)
- **Usage**: `peekaboo image` (screenshot), `peekaboo list` (apps/windows), `peekaboo run <script>` (automation)
- **Learn**: `peekaboo learn` for comprehensive AI agent usage guide
- **Note**: Works in headful mode only (needs a display). All agents in tmux sessions have access.


### gogcli (Google Workspace CLI)
- **Binary**: `gog`
- **Use for**: Gmail (search, send, archive, labels, drafts, filters), Calendar (list/create/update events, free/busy, conflicts), Drive (list/upload/download), Contacts, Tasks, Sheets, Docs
- **Auth**: OAuth via `gog auth credentials` + `gog auth add`
- **Accounts**: Configure during onboarding. Use `-a email@gmail.com` to specify which account.
- **Multi-account**: Use `-a email@gmail.com` or `--account email@gmail.com` flag
- **JSON output**: All commands support `-j` or `--json` for structured output
- **Plain output**: Use `-p` or `--plain` for TSV parseable output
- **Usage examples**:
  - `gog gmail ls -a YOUR_EMAIL "is:unread" --max 10`
  - `gog gmail send -a YOUR_EMAIL --to "user@example.com" --subject "Subject" --body "Body"`
  - `gog calendar ls -a YOUR_EMAIL --max 5`
  - `gog calendar create -a YOUR_EMAIL --summary "Meeting" --start "2026-03-28T14:00:00" --end "2026-03-28T15:00:00"`
  - `gog drive ls -a YOUR_EMAIL --max 10`
- **Important**: gog replaces Gmail/Calendar MCP tools. Use gog instead of MCP for full capabilities (send, archive, labels).
