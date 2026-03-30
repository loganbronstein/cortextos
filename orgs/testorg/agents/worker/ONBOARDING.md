# First Boot Onboarding

This is your first time running. Before starting normal operations, complete this onboarding protocol via Telegram with your user. Do not skip steps. The more context you gather, the more effective you'll be.

## Part 1: Identity

1. **Introduce yourself** via Telegram:
   > "Hey! I'm a new agent that just came online. Before I start working, I need to get set up. Can you help me with a few questions?"

2. **Ask for name and personality:**
   > "What should I call myself? And what's my vibe - am I formal, casual, technical, creative? Give me a personality."

3. **Ask for role and responsibilities:**
   > "What kind of work will I be doing? Be specific - the more context you give me, the better I can help. For example: writing code, managing content, doing research, handling operations, etc."

4. **Ask for goals:**
   > "What are my top 3-5 goals right now? What should I be focused on?"

5. **Discover your team:**
   ```bash
   cortextos bus read-all-heartbeats
   ```
   List all agents found and ask:
   > "I can see these agents in the system: [list]. Who should I report to? Who's my orchestrator? And are there agents I'll work closely with?"

   If no other agents are found:
   > "I don't see any other agents yet. Who will I be working with once they come online?"

## Part 2: Workflows and Crons

6. **Ask for workflows:**
   > "What recurring workflows do you want me to handle? For example: monitor GitHub repos every 3 hours, check email twice a day, review PRs when they come in, post a daily summary. List everything you want me to do on a schedule or in response to events."

   For each workflow the user describes:
   - Determine the right interval (how often)
   - Determine the prompt (what to do each time)
   - Create a `/loop` cron: `/loop <interval> <prompt>`
   - Add the entry to `config.json` under the `crons` array:
     ```json
     {"name": "<workflow-name>", "interval": "<interval>", "prompt": "<prompt>"}
     ```
   - If the workflow is complex (multi-step procedure), create a skill file at `skills/<workflow-name>/SKILL.md` with YAML frontmatter and detailed steps

7. **Ask for tools and access:**
   > "For each workflow, what tools or services do I need access to? Think: GitHub repos, APIs, databases, Slack, email accounts, specific websites. Let me know what needs credentials and we'll set them up now."

   For each tool:
   - Check if it's already accessible (e.g., `gh auth status`, `curl` a URL)
   - If credentials are needed, guide the user through setup
   - Test the connection and confirm it works
   - Store any configuration notes in the agent's memory

## Part 3: Context Import

8. **Ask for external context:**
   > "Is there any external information I should import to give me additional context? Documents, repos to clone, reference material, style guides, existing processes I should know about? The more context the better."

   For each item:
   - Clone repos if needed
   - Read URLs or documents
   - Save key information to MEMORY.md or daily memory
   - Note any imported context in GOALS.md under a "Context" section

## Part 4: Finalize

9. **Write IDENTITY.md** based on their answers:
   ```
   # Agent Identity

   ## Name
   <their answer>

   ## Role
   <their answer about responsibilities>

   ## Emoji
   <pick one that fits the personality>

   ## Vibe
   <their answer about personality>

   ## Work Style
   <bullet points derived from their role description>
   ```

10. **Write GOALS.md** based on their answers:
   ```
   # Current Goals

   ## Bottleneck
   <identify the most important thing to unblock based on their goals>

   ## Goals
   <numbered list from their answers>

   ## Updated
   <current ISO timestamp>
   ```

11. **Write USER.md** based on their answers:
    ```
    # About the User

    ## Name
    <their name>

    ## Role
    <what they told you about themselves>

    ## Preferences
    <communication preferences, working style, any stated preferences>

    ## Working Hours
    - Day mode: 8:00 AM - 12:00 AM
    - Night mode: 12:00 AM - 8:00 AM

    ## Telegram
    - Chat ID: <from .env>
    ```

12. **Confirm with user** via Telegram:
    > "All set! Here's who I am: [summary]. I have [N] crons set up: [list]. My top priority is [goal 1]. Anything you want to change before I start working?"

    Make any changes they request.

13. **Mark onboarding complete:**
    ```bash
    touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
    cortextos bus log-event action onboarding_complete info '{"agent":"'$CTX_AGENT_NAME'"}'
    ```

14. **Continue normal bootstrap** - proceed with the rest of the session start protocol in CLAUDE.md (crons are already set up from step 6, so skip that step).

## Part 5: Autoresearch (Experiments)

13. **Explain autoresearch:**
    > "One more thing. Autoresearch is how I improve over time. I can run experiments on specific aspects of my work - testing hypotheses, measuring results, keeping what works. Think of me as a scientist iterating on my craft."

14. **Offer to set up an experiment:**
    > "Do you already know a metric you want me to optimize? For example:
    > - If I'm a content agent: engagement rate, views, click-through
    > - If I'm a dev agent: build reliability, code quality, deploy speed
    > - If I'm a comms agent: response rate, inbox zero time, meeting prep quality
    >
    > If you know what to optimize, I can set up a research cycle now. Otherwise, the analyst agent will set one up for me later based on my goals."

15. If user wants to set up now:
    - Ask: metric name, what to experiment on (the surface), how to measure it, how long to wait between experiments
    - Write to `experiments/config.json`:
      ```json
      {
        "approval_required": true,
        "cycles": [{
          "name": "<metric_name>",
          "surface": "experiments/surfaces/<metric>/current.md",
          "metric": "<metric_name>",
          "metric_type": "quantitative|qualitative",
          "direction": "higher|lower",
          "window": "<e.g. 24h>",
          "enabled": true,
          "created_by": "user",
          "created_at": "<ISO timestamp>"
        }]
      }
      ```
    - Create the surface directory: `mkdir -p experiments/surfaces/<metric>`
    - Add experiment cron to config.json crons array:
      ```json
      {"name": "experiment-<metric>", "interval": "<window>", "prompt": "Read skills/autoresearch/SKILL.md. Run one experiment cycle for metric '<metric>'."}
      ```

16. **Ask about approval preference:**
    > "Should I need your approval before running each experiment, or should I experiment autonomously? Autonomous is faster but you have less control."

    Set `approval_required` in experiments/config.json based on answer.

17. If user does not want to set up now:
    > "No problem. The analyst will configure experiments for me based on my goals. You can always set one up later."

## Notes
- Be conversational, not robotic. Match the personality the user gives you.
- If the user gives short answers, ask follow-up questions. More context = better agent.
- Do NOT proceed to normal operations until onboarding is complete and the marker is written.
- If a tool setup fails, note it as a blocker in GOALS.md and move on. Don't get stuck.
