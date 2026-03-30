---
name: Task System
description: Create, manage, and complete tasks in cortextOS. Use when starting significant work, tracking progress, or completing deliverables.
---

# Task System

Every significant piece of work must have a corresponding task. Tasks enable coordination, accountability, and measurable progress.

## Task Types

- **Agent tasks** - Work executed autonomously by the assigned agent
- **Human tasks** - Requires human decision, input, or approval (assigned_to=human)

## Lifecycle

### 1. Create (BEFORE starting work)
```bash
bash $CTX_FRAMEWORK_ROOT/bus/create-task.sh \
  "<title>" "<description>" [assignee] [priority] [project]
```

### 2. Mark in progress
```bash
bash $CTX_FRAMEWORK_ROOT/bus/update-task.sh <task_id> in_progress
```

### 3. Execute the work

### 4. Complete
```bash
bash $CTX_FRAMEWORK_ROOT/bus/complete-task.sh <task_id> "[output summary]"
```

### 5. Log KPI (if measurable)
```bash
bash $CTX_FRAMEWORK_ROOT/bus/log-event.sh action task_completed info \
  '{"task_id":"ID","kpi_key":"metric_name","value":1}'
```

## The `needs_approval` Field

**true** - external actions: sending emails, merging PRs, deploying, public announcements
**false** - internal work: research, drafts, feature branches, testing

Tasks with `needs_approval: true` create an approval item that must be reviewed before executing external actions.

## Script Reference

| Action | Command |
|--------|---------|
| Create | `bash $CTX_FRAMEWORK_ROOT/bus/create-task.sh "<title>" "<desc>" [assignee] [priority] [project]` |
| List | `bash $CTX_FRAMEWORK_ROOT/bus/list-tasks.sh [--status S] [--agent A] [--priority P]` |
| Update | `bash $CTX_FRAMEWORK_ROOT/bus/update-task.sh <id> <status> [note]` |
| Complete | `bash $CTX_FRAMEWORK_ROOT/bus/complete-task.sh <id> "[summary]"` |
| Log event | `bash $CTX_FRAMEWORK_ROOT/bus/log-event.sh <category> <event> <severity> '[json]'` |

**Statuses:** pending, in_progress, blocked, completed

**Priorities:** high, normal, low

## Best Practices

- **Always create before starting** - ensures tracking and coordination
- **Be specific** - clear titles, descriptions with success criteria
- **Complete thoroughly** - include what was accomplished and where outputs are
- **Log KPIs** - when work advances a measurable goal
