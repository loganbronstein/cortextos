import { readdirSync, readFileSync, existsSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { hardRestart } from '../bus/system.js';
import type { InboxMessage, BusPaths, TelegramMessage, TelegramCallbackQuery } from '../types/index.js';
import { checkInbox, ackInbox } from '../bus/message.js';
import { updateApproval } from '../bus/approval.js';
import { AgentProcess } from './agent-process.js';
import type { TelegramAPI } from '../telegram/api.js';
import { KEYS } from '../pty/inject.js';
import { stripControlChars, sanitizeForPtyInjection, wrapFenceSafe } from '../utils/validate.js';
import { detectContextLimitModal, hasIdleInputPrompt } from './context-modal-detector.js';

type LogFn = (msg: string) => void;

// /compact modal frozen-gate tuning. A real wedge is STATIC for minutes (scribe's
// 2026-06-04 freeze redrew the modal only ~every 7min over 5.5h), so requiring the
// buffer tail to be byte-identical across 2 consecutive ~1s polls is enough to act
// in ~2s while a healthy agent's animating spinner (which mutates the tail every
// poll) never qualifies.
const MODAL_FROZEN_POLLS = 2;             // consecutive static polls before acting
const MODAL_SCAN_LEN = 8000;              // chars of the current frame; modal-detect, idle-detect and
                                          // staticness all run on this SAME char-bounded region (getRecent
                                          // counts chunks, not chars, so we slice the ring tail ourselves)
const MODAL_RESTART_COOLDOWN_MS = 30_000; // after firing, suppress re-fire while stop()+start() completes

// Auth-wedge (401) gate tuning (codex RCA 401-auth-wedge 2026-06-21). A live 401 auth wedge
// keeps a running PTY alive (handleExit never fires) while every model call fails, so daemon
// process-liveness lies and heartbeats/inbox work silently stall until a restart reloads auth.
// The real fleet incident (codex-verified against stored stdout) renders ONE padded error line per
// failed call, with retries kilobytes apart — so a SINGLE current-frame runtime line is the signature
// (requiring two 401s in one scan window missed the actual wedge). FALSE-POSITIVE GUARD: the fleet
// routinely QUOTES the error in incident reports (the RCA, this build task). Two guards: (a) ADJACENCY
// — the runtime joins the login prompt and the 401 on one line with a ·/-/dash connector, whereas a
// report writes them as separate quoted strings ("Please run /login" + "API Error: 401"), which the
// pattern does not match; (b) for a RESTART, the frame must be byte-STATIC across AUTH_WEDGE_FROZEN_POLLS
// consecutive polls — a healthy agent quoting the error is actively scrolling and never freezes. (Unlike
// the /compact modal, a 401 wedge STILL shows the input prompt, so !hasIdleInputPrompt is not usable.)
const AUTH_WEDGE_FROZEN_POLLS = 3;          // consecutive byte-static polls with the signature = repeated evidence
const AUTH_WEDGE_SCAN_LEN = 8000;           // chars of the current frame to scan (one padded runtime error screen)
const AUTH_RESTART_COOLDOWN_MS = 60_000;    // after firing, suppress re-fire while preserve stop()+start() completes
const AUTH_CIRCUIT_WINDOW_MS = 30 * 60_000; // AUTH_CIRCUIT_MAX restarts within this window trips the breaker
const AUTH_CIRCUIT_MAX = 3;
const AUTH_CIRCUIT_PAUSE_MS = 30 * 60_000;  // pause auto-restarts after tripping; alert for manual /login

/**
 * Detect the live Claude Code 401 auth-wedge signature in a PTY frame (codex RCA 401-auth-wedge).
 * Matches ONLY a real Claude UI error LINE: a line start (string start or after CR/LF) + the "⏺"
 * output marker + the login prompt joined to "API Error: 401" by a ·/-/dash/space separator
 * ("⏺ Please run /login · API Error: 401 ..."). The real invalid-credentials and socket frames all
 * carry this ⏺-prefixed login-join, so there is no standalone variant fallback. The line-start + "⏺"
 * anchor is the quote guard: our own gate/RCA traffic quotes the exact joined line INLINE in prose,
 * where the "⏺" sits mid-line (after a quote) and is rejected. Repeated evidence for a restart is the
 * caller's 3-static-poll gate, NOT a second occurrence (real frames show one padded error line, retries
 * KB apart). `occurrences` is returned for observability only and no longer gates `wedged`.
 */
export function detectAuthWedge(frame: string): { wedged: boolean; occurrences: number } {
  const f = stripControlChars(frame);
  const occurrences = (f.match(/API Error:\s*401/gi) || []).length;
  // ONLY a real Claude UI error LINE counts: anchored at a line start (string start or after CR/LF),
  // the "⏺" output marker, then the login prompt adjacent to "API Error: 401" via a short run of
  // whitespace / middle-dot / dash connectors (tolerant of the real "·"/"-"/spacing). The line-start +
  // "⏺" anchor is the quote guard: our own gate/RCA traffic quotes the exact joined line INLINE in
  // prose (e.g. ... "⏺ Please run /login · API Error: 401 ..." ...), where the "⏺" sits mid-line after
  // a quote and so is rejected. The real invalid-credentials AND socket frames all carry this
  // ⏺-prefixed login-join (codex verified against stored logs), so there is no standalone variant match.
  const wedged = /(?:^|[\r\n])\s*⏺\s*Please run \/login[\s·–—\-]{1,5}API Error:\s*401/i.test(f);
  return { wedged, occurrences };
}

/**
 * Fast message checker for a single agent.
 * Replaces fast-checker.sh: polls Telegram and inbox, injects into PTY.
 */
export class FastChecker {
  private agent: AgentProcess;
  private paths: BusPaths;
  private running: boolean = false;
  private pollInterval: number;
  private log: LogFn;
  private typingLastSent: number = 0;
  // Hook-based typing: track when we last injected a Telegram message (ms)
  private lastMessageInjectedAt: number = 0;
  // Track outbound message log size to detect when agent sends a reply
  private outboundLogSize: number = 0;
  // Track stdout log size to detect when agent is actively producing output
  private stdoutLogSize: number = -1;
  private frameworkRoot: string;
  private telegramApi?: TelegramAPI;
  private chatId?: string;
  private allowedUserId?: number;

  // External Telegram handler (set by daemon)
  private telegramMessages: Array<{ formatted: string; ackIds: string[] }> = [];

  // Persistent dedup: message hashes to prevent duplicate delivery
  private seenHashes: Set<string> = new Set();
  private dedupFilePath: string = '';

  // SIGUSR1 wake: resolve to immediately wake from sleep
  private wakeResolve: (() => void) | null = null;

  // Idle-session heartbeat watchdog
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Context monitor state
  private ctxConfigMtime: number = 0;
  private ctxWarningFiredAt: number = 0;    // dedup: 15min cooldown between warnings
  private ctxHandoffFiredAt: number = 0;    // fires once per session (0 = not yet)
  private ctxHandoffDeadlineAt: number = 0; // timestamp after which force-restart fires
  private ctxLastSessionId: string | null = null; // detects new session → clears stale deadline
  private ctxCircuitRestarts: number[] = []; // timestamps of recent context-triggered restarts
  private ctxCircuitBrokenAt: number | null = null; // when circuit tripped (null = healthy)
  // Persisted to disk so --continue restarts don't reset the circuit breaker
  private ctxCircuitFile: string = '';
  // /compact modal frozen-gate: a real wedge is STATIC, so we only act when the
  // modal signature persists with a byte-identical buffer tail across consecutive
  // polls. An agent merely printing the modal in active output keeps scrolling,
  // so its tail changes every poll and never trips this.
  private ctxModalLastTail: string | null = null; // current frame last poll the modal was seen frozen
  private ctxModalFrozenPolls: number = 0;         // consecutive polls: modal present + frame unchanged
  private ctxModalRestartAt: number = 0;           // last time the modal gate fired a restart (re-fire cooldown)
  // Auth-wedge (401) gate — a SEPARATE detector + circuit from the context path (codex RCA).
  private authWedgeLastFrame: string | null = null; // frame the last poll the auth signature was seen frozen
  private authWedgeFrozenPolls: number = 0;         // consecutive byte-static polls: 401 signature present
  private authRestartAt: number = 0;                // last time the auth gate fired a refresh (re-fire cooldown)
  private authCircuitRestarts: number[] = [];       // timestamps of recent auth-triggered restarts
  private authCircuitBrokenAt: number | null = null; // when the auth circuit tripped (null = healthy)
  private authCircuitFile: string = '';             // persisted so --continue restarts don't reset the breaker

  constructor(
    agent: AgentProcess,
    paths: BusPaths,
    frameworkRoot: string,
    options: { pollInterval?: number; log?: LogFn; telegramApi?: TelegramAPI; chatId?: string; allowedUserId?: number } = {},
  ) {
    this.agent = agent;
    this.paths = paths;
    this.frameworkRoot = frameworkRoot;
    this.pollInterval = options.pollInterval || 1000;
    this.log = options.log || ((msg) => console.log(`[fast-checker/${agent.name}] ${msg}`));
    this.telegramApi = options.telegramApi;
    this.chatId = options.chatId;
    this.allowedUserId = options.allowedUserId;

    // Initialize persistent dedup
    this.dedupFilePath = join(paths.stateDir, '.message-dedup-hashes');
    this.loadDedupHashes();

    // Load persisted circuit breaker state so --continue restarts don't reset it
    this.ctxCircuitFile = join(paths.stateDir, '.ctx-circuit.json');
    this.loadCtxCircuit();
    this.authCircuitFile = join(paths.stateDir, '.auth-circuit.json');
    this.loadAuthCircuit();
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.log('Starting. Waiting for bootstrap...');

    // Register SIGUSR1 handler for immediate wake
    const sigusr1Handler = () => {
      this.log('SIGUSR1 received - waking immediately');
      if (this.wakeResolve) {
        this.wakeResolve();
        this.wakeResolve = null;
      }
    };
    if (process.platform !== 'win32') {
      process.on('SIGUSR1', sigusr1Handler);
    }

    // Wait for bootstrap
    await this.waitForBootstrap();
    this.log('Bootstrap complete. Beginning poll loop.');

    // Idle-session heartbeat watchdog: fires every 50 min regardless of REPL state
    const HEARTBEAT_INTERVAL_MS = 50 * 60 * 1000;
    const agentName = this.agent.name;
    this.heartbeatTimer = setInterval(() => {
      // Watchdog suppression (codex RCA): never claim "alive" over a live 401 auth wedge —
      // a process that is running but 401-ing on every model call is NOT healthy, and a stale
      // "[watchdog] alive" heartbeat would mask it. The checkAuthWedge poll path handles recovery.
      if (!this.watchdogShouldReportAlive()) {
        this.log(`[watchdog] ${agentName} auth-wedge signature present — suppressing alive heartbeat`);
        return;
      }
      const ts = new Date().toISOString();
      execFile('cortextos', ['bus', 'update-heartbeat', `[watchdog] ${agentName} alive — idle session ${ts}`], (err) => {
        if (err) this.log(`Heartbeat watchdog error: ${err.message}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    while (this.running) {
      try {
        // Check for urgent signal file
        this.checkUrgentSignal();
        await this.pollCycle();
      } catch (err) {
        this.log(`Poll error: ${err}`);
      }
      await this.sleepInterruptible(this.pollInterval);
    }

    if (process.platform !== 'win32') {
      process.removeListener('SIGUSR1', sigusr1Handler);
    }
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    this.running = false;
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Trigger immediate wake from sleep.
   * Cross-platform alternative to SIGUSR1, called by IPC 'wake' command.
   */
  wake(): void {
    if (this.wakeResolve) {
      this.wakeResolve();
      this.wakeResolve = null;
    }
  }

  /**
   * Queue a formatted Telegram message for injection.
   * Called by the daemon's Telegram handler.
   */
  queueTelegramMessage(formatted: string): void {
    this.telegramMessages.push({ formatted, ackIds: [] });
  }

  /**
   * Single poll cycle: check inbox + queued Telegram messages.
   */
  private async pollCycle(): Promise<void> {
    let messageBlock = '';
    const ackIds: string[] = [];

    // Process queued Telegram messages
    let hasTelegramMessage = false;
    while (this.telegramMessages.length > 0) {
      const msg = this.telegramMessages.shift()!;
      messageBlock += msg.formatted;
      hasTelegramMessage = true;
    }

    // Check agent inbox
    const inboxMessages = checkInbox(this.paths);
    for (const msg of inboxMessages) {
      messageBlock += this.formatInboxMessage(msg);
      ackIds.push(msg.id);
    }

    // Inject if there's anything
    if (messageBlock) {
      const injected = this.agent.injectMessage(messageBlock);
      if (injected) {
        // ACK inbox messages
        for (const id of ackIds) {
          ackInbox(this.paths, id);
        }
        this.log(`Injected ${messageBlock.length} bytes`);
        // Only update typing timestamp for Telegram messages, not inbox/cron.
        // Inbox messages (agent-to-agent, session continuations) must not
        // restart the typing indicator after Stop has cleared it.
        if (hasTelegramMessage) {
          this.lastMessageInjectedAt = Date.now();
        }
        // Cooldown after injection
        await sleep(5000);
      }
    }

    // Typing indicator: send while Claude is actively working
    if (this.chatId && this.telegramApi && this.isAgentActive()) {
      await this.sendTyping(this.telegramApi, this.chatId);
    }

    // Auth-wedge monitor: detect a live 401 auth wedge (running PTY, failing model calls) and
    // self-heal via a preserve refresh. Runs before the context check — a 401-wedged session
    // can't act on a context handoff prompt anyway.
    await this.checkAuthWedge();

    // Context monitor: check usage thresholds and fire warnings/handoffs
    await this.checkContextStatus();
  }

  /**
   * Format an inbox message for injection.
   * Matches bash fast-checker.sh format exactly.
   */
  private formatInboxMessage(msg: InboxMessage): string {
    const replyNote = msg.reply_to ? ` [reply_to: ${msg.reply_to}]` : '';
    // msg.text/from are externally influenced (a body can carry its own
    // fence/header markers; --body-stdin/--body-file made arbitrary bodies easy
    // to send). The body is wrapped with wrapFenceSafe — a dynamically-sized
    // fence the body cannot close, with the body left byte-exact so pasted code
    // blocks stay readable. The inline `from` is collapse-sanitized (it sits in
    // the header line, not a fence).
    const safeFrom = sanitizeForPtyInjection(msg.from);
    return `=== AGENT MESSAGE from ${safeFrom}${replyNote} [msg_id: ${msg.id}] ===
${wrapFenceSafe(msg.text)}
Reply using: cortextos bus send-message ${safeFrom} normal '<your reply>' ${msg.id}

`;
  }

  /**
   * Format a Telegram text message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramTextMessage(
    from: string,
    chatId: string | number,
    text: string,
    frameworkRoot: string,
    replyToText?: string,
    lastSentText?: string,
    recentHistory?: string,
  ): string {
    // Every externally-influenced field below is untrusted (the sender controls
    // text/display-name; reply-context, last-sent and recent-history are built
    // from prior external messages). Sanitize each so none can escape the fence
    // or forge a containment header. Unfenced context fields (reply/history) are
    // the weakest surface — they sit raw in [Replying to: "..."] / [Recent ...].
    let replyCx = '';
    if (replyToText) {
      replyCx = `[Replying to: "${sanitizeForPtyInjection(replyToText.slice(0, 500))}"]\n`;
    }

    let lastSentCtx = '';
    if (lastSentText) {
      lastSentCtx = `[Your last message: "${sanitizeForPtyInjection(lastSentText.slice(0, 500))}"]\n`;
    }

    let historyCx = '';
    if (recentHistory) {
      historyCx = `[Recent conversation:]\n${sanitizeForPtyInjection(recentHistory)}\n`;
    }

    // Use [USER: ...] wrapper to prevent prompt injection via crafted display names
    // Slash commands (text starting with /) are NOT wrapped in backticks so Claude Code
    // can recognize and invoke them via the Skill tool (e.g. /loop, /commit, /restart).
    // Non-slash bodies use wrapFenceSafe: an unescapable dynamically-sized fence
    // that leaves the body byte-exact (legit code blocks preserved). Slash commands
    // get control-char strip + header-quote only (no fence — must stay invokable).
    const isSlashCommand = /^\/[a-zA-Z]/.test(stripControlChars(text).trim());
    const body = isSlashCommand
      ? sanitizeForPtyInjection(text).trim()
      : wrapFenceSafe(text);
    return `=== TELEGRAM from [USER: ${sanitizeForPtyInjection(from)}] (chat_id:${chatId}) ===
${replyCx}${historyCx}${body}
${lastSentCtx}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram message_reaction update for PTY injection.
   * Reactions are emoji additions/removals on existing messages — they
   * surface to the agent so it can follow up on positive acknowledgements
   * or clarify after a negative reaction.
   *
   * `newReaction` is the current reaction state (an empty list means the
   * user REMOVED their reaction). `oldReaction` lets the formatter
   * distinguish "added X" from "removed Y". Custom emoji (type=custom_emoji)
   * render as [custom_emoji] since we don't resolve the custom_emoji_id.
   */
  static formatTelegramReaction(
    from: string,
    chatId: string | number,
    messageId: number,
    oldReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
    newReaction: Array<{ type: 'emoji'; emoji: string } | { type: 'custom_emoji'; custom_emoji_id: string }>,
  ): string {
    const render = (list: typeof newReaction): string =>
      list.length === 0
        ? '(none)'
        : list.map((r) => (r.type === 'emoji' ? r.emoji : '[custom_emoji]')).join(' ');

    const removed = newReaction.length === 0 && oldReaction.length > 0;
    const label = removed ? `removed ${render(oldReaction)}` : render(newReaction);

    return `=== REACTION from [USER: ${from}] (chat_id:${chatId}) on message ${messageId}: ${label} ===

`;
  }

  /**
   * Format a Telegram photo message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramPhotoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    imagePath: string,
  ): string {
    return `=== TELEGRAM PHOTO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
local_file: ${imagePath}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram document message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramDocumentMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
  ): string {
    return `=== TELEGRAM DOCUMENT from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram voice/audio message for injection.
   * Matches bash fast-checker.sh format.
   *
   * `transcript` is populated by `src/telegram/transcribe.ts` when whisper-cli
   * and the GGML model are available; otherwise it stays undefined and the
   * agent receives only the .ogg path. The codex extractor surfaces the
   * transcript block when present.
   */
  static formatTelegramVoiceMessage(
    from: string,
    chatId: string | number,
    filePath: string,
    duration: number | undefined,
    transcript?: string,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    const transcriptBlock = transcript && transcript.trim()
      ? `transcript:\n${wrapFenceSafe(transcript.trim())}\n`
      : '';
    return `=== TELEGRAM VOICE from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
duration: ${dur}s
local_file: ${filePath}
${transcriptBlock}Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Format a Telegram video/video_note message for injection.
   * Matches bash fast-checker.sh format.
   */
  static formatTelegramVideoMessage(
    from: string,
    chatId: string | number,
    caption: string,
    filePath: string,
    fileName: string,
    duration: number | undefined,
  ): string {
    const dur = duration !== undefined ? duration : 'unknown';
    return `=== TELEGRAM VIDEO from ${sanitizeForPtyInjection(from)} (chat_id:${chatId}) ===
caption:
${wrapFenceSafe(caption)}
duration: ${dur}s
local_file: ${filePath}
file_name: ${sanitizeForPtyInjection(fileName)}
Reply using: cortextos bus send-telegram ${chatId} '<your reply>'

`;
  }

  /**
   * Wait for the agent to finish bootstrapping.
   */
  private async waitForBootstrap(timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.agent.isBootstrapped()) {
        return;
      }
      await sleep(2000);
    }
    this.log('Bootstrap timeout - proceeding anyway');
  }

  /**
   * Send typing indicator, rate-limited to once every 4 seconds.
   */
  private async sendTyping(api: TelegramAPI, chatId: string): Promise<void> {
    const now = Date.now();
    if (now - this.typingLastSent >= 4000) {
      try {
        await api.sendChatAction(chatId, 'typing');
      } catch {
        // Ignore typing indicator failures (matches bash: || true)
      }
      this.typingLastSent = now;
    }
  }

  /**
   * Read the last-sent message file for conversation context.
   * Returns the content (up to 500 chars) or null if not available.
   */
  static readLastSent(stateDir: string, chatId: string | number): string | null {
    const filePath = join(stateDir, `last-telegram-${chatId}.txt`);
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      if (!content) return null;
      return content.slice(0, 500);
    } catch {
      return null;
    }
  }

  /**
   * Handle a callback from the org's activity-channel bot.
   *
   * Runs alongside the agent's primary bot callback handler when the agent
   * is the org's orchestrator (see agent-manager.ts for the wiring). Only
   * appr_(allow|deny)_<approvalId> prefixes are accepted here — the
   * activity-channel bot only ever posts approval buttons, so any other
   * callback is rejected. The responding API must be the activity-channel
   * API (not the agent's own bot) so answerCallbackQuery + editMessageText
   * target the right message on the right bot.
   */
  async handleActivityCallback(query: TelegramCallbackQuery, activityApi: TelegramAPI): Promise<void> {
    const data = stripControlChars(query.data || '');
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Identical
    // check to handleCallback — approval clicks are as sensitive as
    // permission clicks and the same gate applies.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: activity-channel callback from unauthorized user ${fromUserId} - rejecting`);
        try { await activityApi.answerCallbackQuery(callbackQueryId, 'Not authorized'); } catch { /* ignore */ }
        return;
      }
    }

    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (!apprMatch) {
      this.log(`activity-channel callback ignored (unknown prefix): ${data.slice(0, 40)}`);
      try { await activityApi.answerCallbackQuery(callbackQueryId, 'Unknown button'); } catch { /* ignore */ }
      return;
    }

    await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, activityApi);
  }

  /**
   * Shared approval-callback resolution path. Called by both handleCallback
   * (agent's own bot) and handleActivityCallback (activity-channel bot).
   *
   * Resolves the approval via updateApproval (which moves the file from
   * pending/ to resolved/ and notifies the requesting agent via inbox),
   * answers the Telegram callback so the spinner stops, and edits the
   * original message to show who approved/denied for the audit trail.
   *
   * `api` is the TelegramAPI that owns the bot the callback came from —
   * answerCallbackQuery and editMessageText must target the same bot.
   */
  private async routeApprovalCallback(
    decision: 'allow' | 'deny',
    approvalId: string,
    query: TelegramCallbackQuery,
    api: TelegramAPI | undefined,
  ): Promise<void> {
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;
    const status = decision === 'allow' ? 'approved' : 'rejected';

    // Build a friendly audit-trail suffix: "by Alice (@alice)" or just
    // "by Alice" if no username. Falls back to the Telegram user id if
    // both are missing (shouldn't happen in practice but guards edge).
    const firstName = query.from?.first_name;
    const username = query.from?.username;
    const auditWho = firstName && username
      ? `${firstName} (@${username})`
      : firstName ?? (username ? `@${username}` : `user ${query.from?.id ?? 'unknown'}`);
    const auditNote = `via Telegram activity channel by ${auditWho}`;

    try {
      updateApproval(this.paths, approvalId, status, auditNote);
    } catch (err) {
      this.log(`Approval callback: updateApproval failed for ${approvalId}: ${err}`);
      if (api) {
        try { await api.answerCallbackQuery(callbackQueryId, 'Approval not found or already resolved'); } catch { /* ignore */ }
      }
      return;
    }

    if (api) {
      try { await api.answerCallbackQuery(callbackQueryId, decision === 'allow' ? 'Approved' : 'Denied'); } catch { /* ignore */ }
      if (chatId && messageId) {
        const label = decision === 'allow' ? `✅ Approved by ${auditWho}` : `❌ Denied by ${auditWho}`;
        try { await api.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
      }
    }
    this.log(`Approval callback: ${decision} for ${approvalId} by ${auditWho}`);
  }

  /**
   * Handle a Telegram inline button callback query.
   * Routes to permission, restart, or AskUserQuestion handlers.
   */
  async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const data = stripControlChars(query.data || '');
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    const callbackQueryId = query.id;

    // SECURITY: callbacks must come from the whitelisted user. Without this,
    // anyone who sees a button (forwarded message, group, etc.) could click it.
    if (this.allowedUserId !== undefined) {
      const fromUserId = query.from?.id;
      if (fromUserId !== this.allowedUserId) {
        this.log(`SECURITY: callback from unauthorized user ${fromUserId} - rejecting`);
        return;
      }
    }

    // Approval callbacks: appr_(allow|deny)_{approvalId}
    // These originate from the org's activity channel bot (see
    // handleActivityCallback) but may also arrive here if an operator
    // ever routes an approval button through the agent's own bot. The
    // prefix check is cheap and routing-agnostic.
    const apprMatch = data.match(/^appr_(allow|deny)_(approval_\d+_[a-zA-Z0-9]+)$/);
    if (apprMatch) {
      await this.routeApprovalCallback(apprMatch[1] as 'allow' | 'deny', apprMatch[2], query, this.telegramApi);
      return;
    }

    // Permission callbacks: perm_(allow|deny|continue)_{hexId}
    const permMatch = data.match(/^perm_(allow|deny|continue)_([a-f0-9]+)$/);
    if (permMatch) {
      const [, decision, hexId] = permMatch;
      const hookDecision = decision === 'continue' ? 'deny' : decision;
      const responseFile = join(this.paths.stateDir, `hook-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision: hookDecision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const labelMap: Record<string, string> = { allow: 'Approved', deny: 'Denied', continue: 'Continue in Chat' };
          try { await this.telegramApi.editMessageText(chatId, messageId, labelMap[decision] || decision); } catch { /* ignore */ }
        }
      }
      this.log(`Permission callback: ${decision} for ${hexId}`);
      return;
    }

    // Restart callbacks: restart_(allow|deny)_{hexId}
    const restartMatch = data.match(/^restart_(allow|deny)_([a-f0-9]+)$/);
    if (restartMatch) {
      const [, decision, hexId] = restartMatch;
      const responseFile = join(this.paths.stateDir, `restart-response-${hexId}.json`);
      writeFileSync(responseFile, JSON.stringify({ decision }) + '\n', 'utf-8');

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          const label = decision === 'allow' ? 'Restart Approved' : 'Restart Denied';
          try { await this.telegramApi.editMessageText(chatId, messageId, label); } catch { /* ignore */ }
        }
      }
      this.log(`Restart callback: ${decision} for ${hexId}`);
      return;
    }

    // AskUserQuestion single-select: askopt_{questionIdx}_{optionIdx}
    const askoptMatch = data.match(/^askopt_(\d+)_(\d+)$/);
    if (askoptMatch) {
      const qIdx = parseInt(askoptMatch[1], 10);
      const oIdx = parseInt(askoptMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Answered'); } catch { /* ignore */ }
        }
      }

      // Navigate TUI: Down * oIdx, then Enter
      for (let k = 0; k < oIdx; k++) {
        this.agent.write(KEYS.DOWN);
        await sleep(50);
      }
      await sleep(100);
      this.agent.write(KEYS.ENTER);

      this.log(`AskUserQuestion: Q${qIdx} selected option ${oIdx}`);

      // Check for more questions
      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // AskUserQuestion multi-select toggle: asktoggle_{questionIdx}_{optionIdx}
    const toggleMatch = data.match(/^asktoggle_(\d+)_(\d+)$/);
    if (toggleMatch) {
      const qIdx = parseInt(toggleMatch[1], 10);
      const oIdx = parseInt(toggleMatch[2], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Toggled'); } catch { /* ignore */ }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          if (!state.multi_select_chosen) state.multi_select_chosen = [];

          const idx = state.multi_select_chosen.indexOf(oIdx);
          if (idx === -1) {
            state.multi_select_chosen.push(oIdx);
          } else {
            state.multi_select_chosen.splice(idx, 1);
          }
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Update Telegram message with current selections
          if (this.telegramApi && chatId && messageId) {
            const chosen = [...state.multi_select_chosen].sort((a: number, b: number) => a - b);
            const chosenDisplay = chosen.map((i: number) => i + 1).join(', ');
            const question = state.questions?.[qIdx];
            const options: string[] = question?.options || [];

            // Build keyboard with toggle buttons + submit
            const keyboard: Array<Array<{ text: string; callback_data: string }>> = options.map((opt: string, i: number) => [{
              text: opt || `Option ${i + 1}`,
              callback_data: `asktoggle_${qIdx}_${i}`,
            }]);
            keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${qIdx}` }]);

            const text = chosenDisplay
              ? `Selected: ${chosenDisplay}\nTap more options or Submit`
              : 'Tap options to toggle, then tap Submit';

            try {
              await this.telegramApi.editMessageText(chatId, messageId, text, { inline_keyboard: keyboard });
            } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      this.log(`AskUserQuestion: Q${qIdx} toggled option ${oIdx}`);
      return;
    }

    // AskUserQuestion multi-select submit: asksubmit_{questionIdx}
    const submitMatch = data.match(/^asksubmit_(\d+)$/);
    if (submitMatch) {
      const qIdx = parseInt(submitMatch[1], 10);

      if (this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Submitted'); } catch { /* ignore */ }
        if (chatId && messageId) {
          try { await this.telegramApi.editMessageText(chatId, messageId, 'Submitted'); } catch { /* ignore */ }
        }
      }

      const askStatePath = join(this.paths.stateDir, 'ask-state.json');
      if (existsSync(askStatePath)) {
        try {
          const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
          const chosenIndices: number[] = [...(state.multi_select_chosen || [])].sort((a, b) => a - b);
          const question = state.questions?.[qIdx];
          const totalOpts = question?.options?.length || 4;

          // Navigate TUI: for each chosen index, move Down from current position, press Space
          let currentPos = 0;
          for (const idx of chosenIndices) {
            const moves = idx - currentPos;
            for (let k = 0; k < moves; k++) {
              this.agent.write(KEYS.DOWN);
              await sleep(50);
            }
            this.agent.write(KEYS.SPACE);
            await sleep(50);
            currentPos = idx;
          }

          // Navigate to Submit button (past all options + 1 for "Other")
          const submitPos = totalOpts + 1;
          const remaining = submitPos - currentPos;
          for (let k = 0; k < remaining; k++) {
            this.agent.write(KEYS.DOWN);
            await sleep(50);
          }
          await sleep(100);
          this.agent.write(KEYS.ENTER);

          this.log(`AskUserQuestion: Q${qIdx} submitted multi-select`);

          // Reset multi_select_chosen
          state.multi_select_chosen = [];
          writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');

          // Check for more questions
          const totalQ = state.total_questions || 1;
          const nextQ = qIdx + 1;
          if (nextQ < totalQ) {
            state.current_question = nextQ;
            writeFileSync(askStatePath, JSON.stringify(state) + '\n', 'utf-8');
            await sleep(500);
            await this.sendNextQuestion(nextQ);
          } else {
            await sleep(500);
            this.agent.write(KEYS.ENTER);
            this.log('AskUserQuestion: submitted all answers');
            try { unlinkSync(askStatePath); } catch { /* ignore */ }
          }
        } catch { /* ignore parse errors */ }
      }
      return;
    }

    // Inject unhandled callbacks as a Telegram message so the agent can process custom button flows.
    // senderName (Telegram first_name) and callback_data are untrusted: sanitize both against
    // PTY-injection before interpolating, matching the text path (sanitizeForPtyInjection at the
    // `=== TELEGRAM from [USER: ...]` header). This block predates #592; #592's hardening was never
    // retrofitted here, leaving forged `=== AGENT MESSAGE`/fence-breakout headers un-neutralized.
    if (chatId && this.agent) {
      const senderName = sanitizeForPtyInjection(query.from?.first_name || 'User');
      const safeData = sanitizeForPtyInjection(data);
      const msg = [
        `=== TELEGRAM from [USER: ${senderName}] (chat_id:${chatId}) ===`,
        `callback_data: ${safeData}`,
        `message_id: ${messageId}`,
        `Reply using: cortextos bus send-telegram ${chatId} '<your reply>'`,
      ].join('\n');
      const injected = this.agent.injectMessage(msg);
      if (injected && this.telegramApi) {
        try { await this.telegramApi.answerCallbackQuery(callbackQueryId, 'Got it'); } catch { /* ignore */ }
      }
      this.log(`Injected unhandled callback to agent: ${data.slice(0, 60)}`);
    } else {
      this.log(`Unhandled callback data (no agent/chatId): ${data}`);
    }
  }

  /**
   * Send the next AskUserQuestion to Telegram.
   * Reads ask-state.json and builds the question message and inline keyboard.
   */
  async sendNextQuestion(questionIdx: number): Promise<void> {
    if (!this.telegramApi || !this.chatId) {
      this.log('sendNextQuestion: no Telegram API or chatId configured');
      return;
    }

    const askStatePath = join(this.paths.stateDir, 'ask-state.json');
    if (!existsSync(askStatePath)) {
      this.log('sendNextQuestion: state file not found');
      return;
    }

    try {
      const state = JSON.parse(readFileSync(askStatePath, 'utf-8'));
      const totalQ = state.total_questions || 1;
      const question = state.questions?.[questionIdx];
      if (!question) {
        this.log(`sendNextQuestion: question ${questionIdx} not found`);
        return;
      }

      const qText = question.question || 'Question';
      const qHeader = question.header || '';
      const qMulti = question.multiSelect === true;
      const qOptions: string[] = question.options || [];

      // Build message text
      let msg = `QUESTION (${questionIdx + 1}/${totalQ}) - ${this.agent.name}:`;
      if (qHeader) msg += `\n${qHeader}`;
      msg += `\n${qText}\n`;
      if (qMulti) {
        msg += '\n(Multi-select: tap options to toggle, then tap Submit)';
      }
      for (let i = 0; i < qOptions.length; i++) {
        msg += `\n${i + 1}. ${qOptions[i] || `Option ${i + 1}`}`;
      }

      // Build inline keyboard
      let keyboard: Array<Array<{ text: string; callback_data: string }>>;
      if (qMulti) {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `asktoggle_${questionIdx}_${i}`,
        }]);
        keyboard.push([{ text: 'Submit Selections', callback_data: `asksubmit_${questionIdx}` }]);
      } else {
        keyboard = qOptions.map((opt, i) => [{
          text: opt || `Option ${i + 1}`,
          callback_data: `askopt_${questionIdx}_${i}`,
        }]);
      }

      await this.telegramApi.sendMessage(this.chatId, msg, { inline_keyboard: keyboard });
      this.log(`Sent question ${questionIdx + 1}/${totalQ} to Telegram`);
    } catch (err) {
      this.log(`sendNextQuestion error: ${err}`);
    }
  }

  /**
   * Sleep that can be interrupted by SIGUSR1.
   */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Check for .urgent-signal file and process it.
   */
  private checkUrgentSignal(): void {
    const urgentPath = join(this.paths.stateDir, '.urgent-signal');
    if (existsSync(urgentPath)) {
      try {
        const content = readFileSync(urgentPath, 'utf-8').trim();
        this.log(`Urgent signal detected: ${content}`);
        unlinkSync(urgentPath);

        // Inject the urgent message — fence the body unescapably (#592 follow-up)
        // so a signal payload carrying its own fence can't break out and forge
        // daemon containment headers.
        if (content) {
          const urgentMsg = `=== URGENT SIGNAL ===\n${wrapFenceSafe(content)}\n\n`;
          this.agent.injectMessage(urgentMsg);
        }
      } catch (err) {
        this.log(`Error processing urgent signal: ${err}`);
      }
    }
  }

  /**
   * Read ctx thresholds from config.json with mtime-based caching (BUG-048 pattern).
   * Re-reads from disk only when the file has changed so dashboard updates take effect
   * within one poll cycle without a daemon restart.
   */
  private getCtxThresholds(): { warn: number; handoff: number } {
    try {
      const configPath = join(this.agent.getAgentDir(), 'config.json');
      const mtime = statSync(configPath).mtimeMs;
      if (mtime !== this.ctxConfigMtime) {
        const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
        const config = this.agent.getConfig();
        config.ctx_warning_threshold = cfg.ctx_warning_threshold;
        // Accept `ctx_autoreset_threshold` as an alias for `ctx_handoff_threshold`.
        // Agent configs authored since the 2026-05-11 baseline use the former, but
        // the daemon only ever read the latter — leaving those agents in observe-only
        // mode (auto-reset never armed). Reading either key re-arms them with no
        // per-agent config churn. See ROOT CAUSE: scribe context-exhaustion 2026-06-04.
        config.ctx_handoff_threshold = cfg.ctx_handoff_threshold ?? cfg.ctx_autoreset_threshold;
        this.ctxConfigMtime = mtime;
      }
    } catch { /* keep stale values */ }
    const config = this.agent.getConfig();
    return {
      warn: config.ctx_warning_threshold ?? 70,
      handoff: config.ctx_handoff_threshold ?? 80,
    };
  }

  /**
   * Context monitor — called on every poll cycle.
   * Reads context_status.json written by the statusLine bridge hook and takes
   * action when thresholds are crossed.
   */
  private async checkContextStatus(): Promise<void> {
    const now = Date.now();

    // Circuit breaker: check if we should pause auto-restarts
    if (this.ctxCircuitBrokenAt !== null) {
      if (now - this.ctxCircuitBrokenAt >= 30 * 60_000) {
        this.ctxCircuitBrokenAt = null;
        this.ctxCircuitRestarts = [];
        this.saveCtxCircuit();
        this.log('Context circuit breaker reset after 30min pause');
      } else {
        return; // still paused
      }
    }

    // PTY hard signal — the "/compact" context-limit modal. Runs BEFORE the
    // context_status.json read below and acts regardless of threshold config:
    // when a session freezes at the modal the statusline stops writing
    // context_status.json, so it goes stale and the threshold path (which returns
    // early on a stale/missing file) goes blind — the exact failure that wedged
    // scribe ~5.5h on 2026-06-04. forceContextRestart() does stop()+start(), which
    // kills the frozen process and brings up a clean fresh session, self-clearing
    // the wedge regardless of bridge-file staleness (this path is bridge-independent).
    //
    // FROZEN-GATE (false-positive guard): the fleet routinely *quotes* this modal in
    // normal output (incident write-ups, this very fix), and restarting a healthy
    // agent for talking about the modal would be a worse regression than the bug. Two
    // grounded discriminators (verified against real 2026-06-04 captures of scribe's
    // wedge vs boss/marketing quoting the modal):
    //   1. STATIC: a real wedge is byte-frozen — it redrew the modal frame only
    //      ~every 7min over a 5.5h freeze, so the buffer tail is identical across
    //      consecutive polls. An agent printing the modal in active output keeps
    //      scrolling (its spinner counts "for Ns" and animates every poll), so its
    //      tail changes and never qualifies. Both wedge and healthy show a ✻ spinner;
    //      only ANIMATION separates them, which the tail comparison captures.
    //   2. NO INPUT PROMPT: the one static FP is an agent that quoted the modal then
    //      went idle. An idle/ready session renders the input bottom-bar ("/clear to
    //      save N tokens", "new task?", "? for shortcuts"); a wedged session cannot
    //      accept input and shows none of these. hasIdleInputPrompt() excludes it.
    // Scan and freeze the SAME char-bounded current-frame region. getRecent(n) counts
    // CHUNKS not chars, so scanning getRecent(8000) for the modal while comparing only a
    // fixed-byte tail for staticness would let an OLD quote (anywhere in a large window)
    // pair with an unrelated static tail. Running modal-detect, idle-detect and the
    // staticness compare on one ~one-frame slice means we only act on the modal as the
    // CURRENT frozen frame.
    const frame = (this.agent.getOutputBuffer()?.getRecent() ?? '').slice(-MODAL_SCAN_LEN);
    const wedgeShape = detectContextLimitModal(frame) && !hasIdleInputPrompt(frame);
    if (now - this.ctxModalRestartAt < MODAL_RESTART_COOLDOWN_MS) {
      // A wedge restart just fired. stop()+start() takes a few seconds, during which the
      // old frozen buffer is still visible; suppressing re-fire keeps one wedge counting as
      // one restart against the circuit breaker. After the cooldown, a still-wedged session
      // (failed restart) re-fires and the circuit breaker bounds the repeats.
    } else if (wedgeShape) {
      this.ctxModalFrozenPolls = frame === this.ctxModalLastTail ? this.ctxModalFrozenPolls + 1 : 1;
      this.ctxModalLastTail = frame;
      if (this.ctxModalFrozenPolls >= MODAL_FROZEN_POLLS) {
        this.log(`Context-limit /compact modal frozen in PTY (static ${this.ctxModalFrozenPolls} polls, no input prompt) — force restarting (self-clear)`);
        this.ctxModalFrozenPolls = 0;
        this.ctxModalLastTail = null;
        this.ctxModalRestartAt = now;
        this.forceContextRestart('context-limit /compact modal — session frozen (static buffer, no input prompt)');
        return;
      }
    } else if (this.ctxModalFrozenPolls !== 0) {
      // modal cleared, output moved on, or input prompt back — reset frozen tracking
      this.ctxModalFrozenPolls = 0;
      this.ctxModalLastTail = null;
    }

    // Read the bridge file written by hook-context-status
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    if (!existsSync(statusPath)) return;

    let pct: number | null = null;
    let exceeds200k = false;
    try {
      const raw = readFileSync(statusPath, 'utf-8');
      const data = JSON.parse(raw);
      const age = now - new Date(data.written_at || 0).getTime();
      if (age > 10 * 60_000) return; // stale file — skip
      pct = typeof data.used_percentage === 'number' ? data.used_percentage : null;
      exceeds200k = Boolean(data.exceeds_200k_tokens);

      // Detect new session: if session_id changed, clear stale per-session ctx state.
      // This handles the case where the agent self-restarts (voluntary handoff) and the
      // 5-min deadline timer would otherwise fire on the fresh low-context session.
      const incomingSessionId = typeof data.session_id === 'string' ? data.session_id : null;
      if (incomingSessionId && incomingSessionId !== this.ctxLastSessionId) {
        if (this.ctxLastSessionId !== null) {
          this.ctxHandoffFiredAt = 0;
          this.ctxHandoffDeadlineAt = 0;
          this.ctxWarningFiredAt = 0;
          this.log(`New session detected (${incomingSessionId.slice(0, 8)}…) — per-session ctx state reset`);
        }
        this.ctxLastSessionId = incomingSessionId;
      }
    } catch { return; }

    // Check PTY output for hard API overflow errors (always act regardless of threshold config)
    const recentOutput = this.agent.getOutputBuffer()?.getRecent(8000) ?? '';
    if (/extra usage.*?1[Mm] context|conversation too long.*?compaction/i.test(recentOutput)) {
      this.log('Context overflow error detected in PTY output — force restarting');
      this.forceContextRestart('API overflow error in PTY output');
      return;
    }

    const { warn, handoff } = this.getCtxThresholds();

    // No threshold configured — observe-only mode (log but don't act)
    if (this.agent.getConfig().ctx_handoff_threshold === undefined) return;

    const effectivePct = pct ?? (exceeds200k ? 101 : null);
    if (effectivePct === null) return;

    // Tier 3: deadline exceeded — force restart if agent ignored handoff prompt
    if (this.ctxHandoffDeadlineAt > 0 && now > this.ctxHandoffDeadlineAt) {
      this.log(`Handoff deadline exceeded (${Math.round(effectivePct)}%) — force restarting`);
      this.ctxHandoffDeadlineAt = 0;
      this.forceContextRestart(`ctx ${Math.round(effectivePct)}% — handoff not completed within 5min`);
      return;
    }

    // Tier 1: warning — PTY injection only, no Telegram ping (context management is internal)
    if (effectivePct >= warn && now - this.ctxWarningFiredAt > 15 * 60_000) {
      this.ctxWarningFiredAt = now;
      const pctRound = Math.round(effectivePct);
      const statusSuffix = effectivePct >= handoff ? 'Handoff in progress.' : `Handoff triggers at ${handoff}%.`;
      this.agent.injectMessage(`[CONTEXT] Window at ${pctRound}%. ${statusSuffix}`);
      this.log(`Context warning fired at ${pctRound}%`);
    }

    // Tier 2: handoff (fires once per session lifecycle)
    if (effectivePct >= handoff && this.ctxHandoffFiredAt === 0) {
      this.ctxHandoffFiredAt = now;
      this.ctxHandoffDeadlineAt = now + 5 * 60_000; // 5min grace for agent to cooperate
      // Reset context_status.json so the new session doesn't re-trigger immediately
      const statusPath = join(this.paths.stateDir, 'context_status.json');
      try {
        writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
      } catch { /* non-fatal */ }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
      const handoffPrompt = `[CONTEXT HANDOFF REQUIRED] Context is at ${Math.round(effectivePct)}%. Write a handoff document to memory/handoffs/handoff-${ts}.md with these sections: ## Current Tasks, ## Next Actions, ## Active Crons, ## Key Context, ## Files Modified This Session. Then run: cortextos bus hard-restart --reason "context handoff at ${Math.round(effectivePct)}%" --handoff-doc <absolute path to the handoff doc you just wrote>. Do this NOW before the context window is exhausted.`;
      this.agent.injectMessage(handoffPrompt);
      this.log(`Handoff prompt injected at ${Math.round(effectivePct)}%`);
      // Pre-arm .force-fresh so the next restart is always a clean fresh session.
      // If the agent cooperates and calls hard-restart, it also writes .force-fresh — no-op.
      // If context exhausts naturally before the agent acts, .force-fresh is already set,
      // preventing a --continue restart that would loop at the same high context level.
      try {
        writeFileSync(join(this.paths.stateDir, '.force-fresh'), '');
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Force a fresh hard restart for context exhaustion reasons.
   * Writes .force-fresh + .restart-planned, then triggers sessionRefresh().
   * The circuit breaker prevents runaway restart loops.
   */
  private forceContextRestart(reason: string): void {
    const now = Date.now();

    // Update and check circuit breaker window (persisted to disk — survives --continue restarts)
    this.ctxCircuitRestarts = this.ctxCircuitRestarts.filter(t => now - t < 15 * 60_000);
    if (this.ctxCircuitRestarts.length >= 3) {
      this.ctxCircuitBrokenAt = now;
      this.saveCtxCircuit();
      const msg = `Context circuit breaker TRIPPED for ${this.agent.name}: 3 restarts in 15min. Watchdog paused 30min. Check logs/${this.agent.name}/restarts.log for details.`;
      this.log(msg);
      if (this.telegramApi && this.chatId) {
        this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
      }
      return;
    }
    this.ctxCircuitRestarts.push(now);
    this.saveCtxCircuit();

    // If the agent wrote a handoff doc in the last 15 minutes but didn't get to call
    // hard-restart --handoff-doc (e.g. Tier 3 force-restart cut it short), pick it up
    // so the new session still receives handoff context.
    try {
      const handoffsDir = join(this.agent.getAgentDir(), 'memory', 'handoffs');
      if (existsSync(handoffsDir)) {
        const cutoff = now - 15 * 60_000;
        const recent = readdirSync(handoffsDir)
          .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
          .map(f => ({ f, mtime: statSync(join(handoffsDir, f)).mtimeMs }))
          .filter(({ mtime }) => mtime >= cutoff)
          .sort((a, b) => b.mtime - a.mtime);
        if (recent.length > 0) {
          const docPath = join(handoffsDir, recent[0].f);
          const markerPath = join(this.paths.stateDir, '.handoff-doc-path');
          writeFileSync(markerPath, docPath, 'utf-8');
          this.log(`Tier 3 restart: found recent handoff doc, writing marker → ${docPath}`);
        }
      }
    } catch { /* non-fatal — proceed without handoff context */ }

    // Reset per-session context state for the new session
    this.ctxHandoffFiredAt = 0;
    this.ctxHandoffDeadlineAt = 0;
    this.ctxWarningFiredAt = 0;

    // Write .force-fresh + .restart-planned (hardRestart from src/bus/system.ts)
    hardRestart(this.paths, this.agent.name, `CONTEXT-FORCE-RESTART: ${reason}`);

    // Reset context_status.json so the new session's FastChecker doesn't re-trigger
    // Tier 2 immediately by reading the stale high-% value from the previous session.
    const statusPath = join(this.paths.stateDir, 'context_status.json');
    try {
      writeFileSync(statusPath, JSON.stringify({ used_percentage: 0, exceeds_200k_tokens: false, written_at: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    // sessionRefresh('fresh') does stop() + start('fresh') for an explicit clean
    // session (BUG-011). The .force-fresh marker written above remains the durable
    // fallback for an auto/cold start if the daemon exits before this completes.
    this.agent.sessionRefresh('fresh').catch(err => this.log(`Context restart failed: ${err}`));
  }

  /**
   * Whether the idle-session watchdog may claim this agent is "alive" (codex RCA).
   * Returns false when the current PTY frame carries the live 401 auth-wedge signature, so the
   * 50-min watchdog never papers over a session that is running but failing every model call.
   */
  private watchdogShouldReportAlive(): boolean {
    // Defensive optional-call: this runs inside the setInterval watchdog callback, which is
    // NOT wrapped in try/catch — if the buffer is unavailable, default to reporting alive
    // (never throw out of the timer, and never suppress a heartbeat we can't justify).
    const frame = (this.agent.getOutputBuffer?.()?.getRecent?.() ?? '').slice(-AUTH_WEDGE_SCAN_LEN);
    return !detectAuthWedge(frame).wedged;
  }

  /**
   * Detect and self-heal a live 401 auth wedge (codex RCA 401-auth-wedge 2026-06-21).
   * A 401-wedged PTY keeps running (handleExit never fires) while every model call fails, so
   * process liveness lies. We act only on REPEATED evidence: the 401 signature present AND the
   * frame byte-STATIC across AUTH_WEDGE_FROZEN_POLLS consecutive polls (a healthy agent quoting
   * the error is actively scrolling and never freezes; a single quoted mention has one occurrence
   * and fails detectAuthWedge). Recovery is sessionRefresh('preserve') — a fresh Claude process
   * that reloads Keychain auth while keeping conversation.
   */
  private async checkAuthWedge(): Promise<void> {
    const now = Date.now();

    // Auth circuit breaker: if tripped, stay paused until the window elapses (manual /login needed).
    if (this.authCircuitBrokenAt !== null) {
      if (now - this.authCircuitBrokenAt >= AUTH_CIRCUIT_PAUSE_MS) {
        this.authCircuitBrokenAt = null;
        this.authCircuitRestarts = [];
        this.saveAuthCircuit();
        this.log('Auth circuit breaker reset after pause');
      } else {
        return; // still paused
      }
    }

    const frame = (this.agent.getOutputBuffer?.()?.getRecent?.() ?? '').slice(-AUTH_WEDGE_SCAN_LEN);
    const { wedged } = detectAuthWedge(frame);

    // Cooldown: a refresh just fired (stop()+start() takes seconds, the old frame is still
    // visible). Suppressing re-fire keeps one wedge counting as one restart against the breaker.
    if (now - this.authRestartAt < AUTH_RESTART_COOLDOWN_MS) return;

    if (wedged) {
      // Frozen gate: the signature must PERSIST byte-static across consecutive polls. A healthy
      // agent quoting the 401 keeps scrolling (tail mutates) and never reaches the count.
      this.authWedgeFrozenPolls = frame === this.authWedgeLastFrame ? this.authWedgeFrozenPolls + 1 : 1;
      this.authWedgeLastFrame = frame;
      if (this.authWedgeFrozenPolls >= AUTH_WEDGE_FROZEN_POLLS) {
        this.log(`401 auth wedge frozen in PTY (static ${this.authWedgeFrozenPolls} polls, repeated 401 signature) — preserve-refreshing to reload auth`);
        this.authWedgeFrozenPolls = 0;
        this.authWedgeLastFrame = null;
        this.authRestartAt = now;
        this.forceAuthRestart('401 auth wedge — repeated login/401 signature, session frozen');
      }
    } else if (this.authWedgeFrozenPolls !== 0) {
      // signature cleared or output moved on — reset frozen tracking
      this.authWedgeFrozenPolls = 0;
      this.authWedgeLastFrame = null;
    }
  }

  /**
   * Recover from a 401 auth wedge via sessionRefresh('preserve') (reload Keychain auth, keep
   * conversation). A SEPARATE circuit breaker from the context one bounds restart loops: after
   * AUTH_CIRCUIT_MAX restarts within AUTH_CIRCUIT_WINDOW_MS it stops auto-restarting and alerts
   * Telegram + boss that fresh auth is still failing and a manual /login is required.
   */
  private forceAuthRestart(reason: string): void {
    const now = Date.now();

    // Circuit breaker window (persisted across --continue restarts).
    this.authCircuitRestarts = this.authCircuitRestarts.filter(t => now - t < AUTH_CIRCUIT_WINDOW_MS);
    if (this.authCircuitRestarts.length >= AUTH_CIRCUIT_MAX) {
      this.authCircuitBrokenAt = now;
      this.saveAuthCircuit();
      const msg = `Auth circuit breaker TRIPPED for ${this.agent.name}: ${AUTH_CIRCUIT_MAX} auth-restarts in ${Math.round(AUTH_CIRCUIT_WINDOW_MS / 60_000)}min — preserve-refresh is NOT clearing the 401. MANUAL /login required. Auto-restart paused ${Math.round(AUTH_CIRCUIT_PAUSE_MS / 60_000)}min.`;
      this.log(msg);
      this.logEvent('auth_circuit_tripped', { agent: this.agent.name });
      this.alert(msg);
      return;
    }
    this.authCircuitRestarts.push(now);
    this.saveAuthCircuit();

    this.logEvent('auth_wedge_detected', { agent: this.agent.name, reason });
    execFile('cortextos', ['bus', 'update-heartbeat', 'auth-wedge detected; restarting to reload Claude auth'], () => {});

    // sessionRefresh('preserve') does stop()+start() with a fresh Claude process that reloads
    // Keychain auth, keeping the conversation when possible (vs the context path's 'fresh').
    this.agent.sessionRefresh('preserve').catch(err => this.log(`Auth refresh failed: ${err}`));
  }

  /**
   * Alert a human + the orchestrator (Telegram to the agent's chat + a high-priority bus message
   * to boss). Used when the auth circuit trips and only a manual /login can recover the fleet.
   */
  private alert(msg: string): void {
    if (this.telegramApi && this.chatId) this.telegramApi.sendMessage(this.chatId, msg).catch(() => {});
    if (this.agent.name !== 'boss') {
      execFile('cortextos', ['bus', 'send-message', 'boss', 'high', msg], () => {});
    }
  }

  /** Emit a bus action event (fire-and-forget) for dashboard observability. */
  private logEvent(type: string, meta: Record<string, unknown>): void {
    execFile('cortextos', ['bus', 'log-event', 'action', type, 'info', '--meta', JSON.stringify(meta)], () => {});
  }

  /** Load auth circuit breaker state from disk (persisted so --continue restarts can't reset it). */
  private loadAuthCircuit(): void {
    try {
      if (!existsSync(this.authCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.authCircuitFile, 'utf-8'));
      this.authCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.authCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /** Persist auth circuit breaker state to disk after every update. */
  private saveAuthCircuit(): void {
    try {
      writeFileSync(this.authCircuitFile, JSON.stringify({
        restarts: this.authCircuitRestarts,
        brokenAt: this.authCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Compute a hash for message dedup. Uses SHA-256 to avoid collision attacks.
   */
  private hashMessage(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if message has been seen (dedup). Returns true if duplicate.
   */
  isDuplicate(text: string): boolean {
    const hash = this.hashMessage(text);
    if (this.seenHashes.has(hash)) return true;
    this.seenHashes.add(hash);
    this.saveDedupHashes();
    return false;
  }

  /**
   * Load dedup hashes from persistent file.
   */
  private loadDedupHashes(): void {
    try {
      if (existsSync(this.dedupFilePath)) {
        const content = readFileSync(this.dedupFilePath, 'utf-8');
        const hashes = content.trim().split('\n').filter(Boolean);
        // Keep only last 1000 hashes to prevent file bloat
        const recent = hashes.slice(-1000);
        this.seenHashes = new Set(recent);
      }
    } catch {
      // Start fresh on error
      this.seenHashes = new Set();
    }
  }

  /**
   * Save dedup hashes to persistent file.
   */
  private saveDedupHashes(): void {
    try {
      const hashes = Array.from(this.seenHashes).slice(-1000);
      writeFileSync(this.dedupFilePath, hashes.join('\n') + '\n', 'utf-8');
    } catch {
      // Non-critical - dedup will still work in memory
    }
  }

  /**
   * Load circuit breaker state from disk.
   * Persisting this across --continue restarts is critical: without it,
   * the in-memory ctxCircuitRestarts array resets on every restart, making
   * the circuit breaker unable to count restarts and stop a restart loop.
   */
  private loadCtxCircuit(): void {
    try {
      if (!existsSync(this.ctxCircuitFile)) return;
      const data = JSON.parse(readFileSync(this.ctxCircuitFile, 'utf-8'));
      this.ctxCircuitRestarts = Array.isArray(data.restarts) ? data.restarts : [];
      this.ctxCircuitBrokenAt = typeof data.brokenAt === 'number' ? data.brokenAt : null;
    } catch {
      // Start fresh on error
    }
  }

  /**
   * Persist circuit breaker state to disk after every update.
   */
  private saveCtxCircuit(): void {
    try {
      writeFileSync(this.ctxCircuitFile, JSON.stringify({
        restarts: this.ctxCircuitRestarts,
        brokenAt: this.ctxCircuitBrokenAt,
      }), 'utf-8');
    } catch {
      // Non-critical
    }
  }

  /**
   * Check if the agent is actively working on a response (typing indicator).
   *
   * Hook-based approach:
   *   - fast-checker records when it injected a message (lastMessageInjectedAt)
   *   - Stop hook writes a Unix timestamp to state/<agent>/last_idle.flag
   *   - Typing = message was injected AND last_idle.flag is older than injection
   *     AND injection was within the last 10 minutes
   *
   * This is accurate: typing starts when user sends a message, clears the
   * moment Claude finishes its turn (Stop fires). No false positives from TUI.
   */
  isAgentActive(): boolean {
    // Hook-based approach only. Claude Code writes ANSI escape codes (spinner,
    // cursor movement) to stdout constantly even when idle, so stdout.log always
    // grows — using file size as an activity signal produces a permanent "typing"
    // indicator. Instead, rely solely on:
    //   - lastMessageInjectedAt: when fast-checker last pushed a message in
    //   - last_idle.flag: written by the Stop hook when Claude finishes a turn
    // This gives accurate per-turn typing with no false positives.

    if (this.lastMessageInjectedAt === 0) return false;

    const now = Date.now();
    const tenMinMs = 10 * 60 * 1000;
    if (now - this.lastMessageInjectedAt > tenMinMs) return false;

    // Clear typing immediately when the agent sends a reply.
    // outbound-messages.jsonl grows each time the agent calls send-telegram.
    const outboundPath = join(this.paths.logDir, 'outbound-messages.jsonl');
    try {
      if (existsSync(outboundPath)) {
        const { size } = require('fs').statSync(outboundPath);
        if (this.outboundLogSize === 0) {
          // First check: seed baseline, don't trigger yet
          this.outboundLogSize = size;
        } else if (size > this.outboundLogSize) {
          // New reply sent — clear typing state
          this.outboundLogSize = size;
          this.lastMessageInjectedAt = 0;
          return false;
        }
      }
    } catch { /* non-critical */ }

    // Read last_idle.flag written by the Stop hook
    const flagPath = join(this.paths.stateDir, 'last_idle.flag');
    try {
      if (!existsSync(flagPath)) {
        // No idle flag yet — hook hasn't fired, so still working
        return true;
      }
      const idleTs = parseInt(readFileSync(flagPath, 'utf-8').trim(), 10) * 1000;
      // Typing if injection happened AFTER the last idle signal
      return this.lastMessageInjectedAt > idleTs;
    } catch {
      return true; // Can't read flag — assume still active
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
