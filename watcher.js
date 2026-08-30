const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const chokidar = require('chokidar');

// --- Pricing ---
// USD per 1M tokens. Verified against Anthropic's published rates 2026-08-27.
const PRICING = {
  'claude-fable-5':    { input: 10.00, output: 50.00 },
  'claude-mythos-5':   { input: 10.00, output: 50.00 },
  'claude-opus-5':     { input: 5.00,  output: 25.00 },
  'claude-opus-4-8':   { input: 5.00,  output: 25.00 },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00 },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00 },
  'claude-sonnet-5':   { input: 2.00,  output: 10.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00 },
};

// Cache writes cost 1.25x the base input rate, cache reads 0.1x.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

// Context window per model. Every current model is 1M; only Haiku 4.5 is 200K.
const CONTEXT_WINDOW = {
  'claude-fable-5':    1_000_000,
  'claude-mythos-5':   1_000_000,
  'claude-opus-5':     1_000_000,
  'claude-opus-4-8':   1_000_000,
  'claude-opus-4-7':   1_000_000,
  'claude-opus-4-6':   1_000_000,
  'claude-sonnet-5':   1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5':  200_000,
};
const LEGACY_CONTEXT_WINDOW = 200_000;

// An unlisted model is assumed legacy-sized until its own traffic proves
// otherwise — better than reporting a permanent 100%.
function getContextWindow(model, observedInput) {
  const known = model && (CONTEXT_WINDOW[model] || lookupByPrefix(CONTEXT_WINDOW, model));
  if (known) return known;
  return (observedInput || 0) > LEGACY_CONTEXT_WINDOW ? 1_000_000 : LEGACY_CONTEXT_WINDOW;
}

function lookupByPrefix(table, model) {
  for (const [key, val] of Object.entries(table)) {
    if (model.includes(key)) return val;
  }
  return null;
}

function getPricing(model) {
  if (!model) return PRICING['claude-opus-5'];
  if (PRICING[model]) return PRICING[model];
  return lookupByPrefix(PRICING, model) || PRICING['claude-opus-5'];
}

// --- Session State ---
const sessions = new Map();
const fileOffsets = new Map(); // path -> byte offset
const seenMessageIds = new Map(); // sessionId -> Set of message.id

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      projectHash: '',
      cwd: '',
      label: '',
      model: '',
      gitBranch: '',
      status: 'idle',
      tokensIn: 0,
      tokensOut: 0,
      cacheCreationIn: 0,
      cacheReadIn: 0,
      costUSD: 0,
      turnCount: 0,
      activeFiles: [],
      fileTouches: {},   // path -> { at, produced } — ranked into activeFiles on read
      recentPrompts: [], // lowercased human turns, for the "you asked about this" signal
      recentLog: [],
      startedAt: null,
      lastEventAt: null,
      lastEventType: '',
      lastContentTypes: [],
      lastTurnType: '',        // 'user' | 'assistant' — main conversation only
      lastTurnContentTypes: [],
      lastTurnTools: [],
      logBytes: 0,       // size of this session's own log — a proxy for how much work is in it
      lastTurnHandback: false, // true once control is back with the human
      lastTurnAt: null,
      lastTurnInputTotal: 0, // input + cache for context window estimate
      permissionMode: '',
      version: '',
      aiTitle: '',
      subagents: {}, // agentId -> { task, status, tokensOut, lastEventAt }
    });
    seenMessageIds.set(sessionId, new Map()); // messageId -> {in, out, cacheCreate, cacheRead}
  }
  return sessions.get(sessionId);
}

// A slash command leaves several user events behind: the typed line, a caveat
// block, an echo of the command, and its stdout. Only the last of those means
// anything for status — the command ran, and control is back with the human.
// Without this a finished /compact or /login reads as a prompt still awaiting
// an answer, because the raw event type is just 'user'.
const COMMAND_OUTPUT_RE = /^\s*<local-command-(stdout|stderr)>/;
const COMMAND_ECHO_RE = /^\s*<command-(name|message|args|contents)>/;

function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const block = content.find(c => c && c.type === 'text');
  return (block && typeof block.text === 'string') ? block.text : '';
}

// 'handback' — control is with the human; 'pending' — the agent owes a reply;
// null — carries no turn meaning and must not overwrite the previous state.
function classifyTurn(event, contentTypes, content) {
  if (event.isMeta) return null;             // caveat and other injected blocks
  if (event.isCompactSummary) return null;   // the seed written when compacting

  if (event.type === 'assistant') {
    if (contentTypes.includes('tool_use')) return 'pending';
    return contentTypes.includes('text') ? 'handback' : 'pending';
  }

  const text = firstText(content);
  if (COMMAND_OUTPUT_RE.test(text)) return 'handback';
  if (COMMAND_ECHO_RE.test(text)) return null;
  return 'pending';                          // a real prompt, or a tool_result
}

function addToRecentLog(session, entry) {
  session.recentLog.push(entry);
  if (session.recentLog.length > 30) {
    session.recentLog = session.recentLog.slice(-30);
  }
}

// Scratch space and background-task logs are tool plumbing, not work product:
// /tmp/claude-<uid>/ holds task .output files and per-session scratchpads, and
// ~/.claude is Claude Code's own state.
const INTERNAL_PATH_RE = /^(?:\/private)?\/tmp\/claude-\d+\/|\/\.claude\//;
const PRODUCING_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Artifact', 'MultiEdit']);

// Full paths, so a file can actually be opened. `command` used to be read as a
// path here, which turned any single-word shell command into a file chip.
// What a deliverable looks like, in order of how much it is worth surfacing.
const TYPE_SCORE = {
  '.html': 6, '.pptx': 6, '.ppt': 6, '.pdf': 5, '.md': 4, '.docx': 4,
  '.png': 2, '.jpg': 2, '.jpeg': 2, '.svg': 2, '.csv': 1, '.xlsx': 3,
  '.py': -2, '.js': -2, '.ts': -2, '.tsx': -2, '.sh': -2, '.css': -2,
  '.json': -2, '.yaml': -2, '.yml': -2, '.h': -3, '.cc': -3, '.cpp': -3, '.c': -3,
};
// An `en/` subdirectory of a delivery folder holds the English draft that still
// has to go through translation — material, not the thing you asked for.
//
// A -en *sibling* directory is the opposite: a parallel English edition,
// delivered alongside the Chinese one. Same two letters, opposite meaning, and
// only the position in the path tells them apart.
const INTERMEDIATE_RE = /(^|\/)en\//;

function rankFiles(session, limit) {
  const touches = session.fileTouches || {};
  const paths = Object.keys(touches);
  if (!paths.length) return [];

  const times = paths.map(p => new Date(touches[p].at || 0).getTime());
  const newest = Math.max(...times);
  const oldest = Math.min(...times);
  const span = Math.max(1, newest - oldest);
  const prompts = session.recentPrompts || [];

  const scored = paths.map(p => {
    const touch = touches[p];
    const base = path.basename(p);
    const ext = path.extname(base).toLowerCase();
    const why = [];
    let score = 0;

    const intermediate = INTERMEDIATE_RE.test(p);
    const typeScore = TYPE_SCORE[ext];
    if (typeof typeScore === 'number') score += typeScore;
    // Do not call it a deliverable when the next line is about to rule that it
    // is not one.
    if (typeScore >= 4 && !intermediate) why.push('deliverable');

    if (/^readme(\.|$)/i.test(base)) { score += 3; why.push('readme'); }

    // You named it, so it is what you are waiting on. Matched on the whole
    // filename: a bare stem like 'proposal' is an ordinary word, and matching
    // it turns every mention of the topic into a mention of the file.
    const named = base.toLowerCase();
    if (named.length > 4 && prompts.some(t => t.includes(named))) {
      score += 5;
      why.push('you mentioned it');
    }

    if (touch.produced) { score += 2; why.push('written here'); }

    if (intermediate) { score -= 5; why.push('english draft'); }
    // A leading underscore is the usual mark for a template or reference copy.
    if (p.split('/').some(seg => seg.startsWith('_'))) { score -= 2; why.push('supporting'); }

    // Recency breaks ties without being able to outvote type on its own.
    const age = new Date(touch.at || 0).getTime();
    score += 1.5 * ((age - oldest) / span);

    return { path: p, score, why };
  });

  scored.sort((a, b) => b.score - a.score || (b.path < a.path ? 1 : -1));
  return scored.slice(0, limit).map(f => ({ path: f.path, why: f.why.join(' · ') }));
}

function extractActiveFiles(content) {
  const files = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (block.type !== 'tool_use' || !block.input) continue;
    const fp = block.input.file_path || block.input.notebook_path || block.input.path;
    if (!fp || typeof fp !== 'string') continue;
    if (!path.isAbsolute(fp)) continue;
    if (INTERNAL_PATH_RE.test(fp)) continue;
    files.push(fp);
  }
  return files;
}

function processEvent(event, projectHash) {
  if (!event || !event.sessionId) return;
  if (event.type === 'file-history-snapshot' || event.type === 'queue-operation' || event.type === 'last-prompt') return;

  const session = getOrCreateSession(event.sessionId);

  // Claude Code's own title for the conversation. It arrives on an untimestamped
  // event, so it has to be read before the guard below drops those.
  if (event.aiTitle) session.aiTitle = event.aiTitle;

  if (!event.timestamp) return; // skip events without timestamps
  const ts = event.timestamp;

  // Both must be order-independent. Files are read in whatever order the
  // watcher reaches them, subagent logs carry the parent's sessionId, and a
  // compaction writes events out of chronological order inside one file — so
  // last-write-wins would let a months-old subagent event become the session's
  // most recent activity.
  if (!session.startedAt || ts < session.startedAt) session.startedAt = ts;
  if (!session.lastEventAt || ts > session.lastEventAt) session.lastEventAt = ts;
  session.lastEventType = event.type;
  session.projectHash = projectHash;

  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
    const parts = event.cwd.split('/').filter(Boolean);
    session.label = parts.slice(-2).join('/');
  }
  if (event.gitBranch && !session.gitBranch) {
    session.gitBranch = event.gitBranch;
  }
  if (event.version) session.version = event.version;
  if (event.permissionMode) session.permissionMode = event.permissionMode;

  const msg = event.message || {};
  const content = msg.content;
  const contentTypes = Array.isArray(content)
    ? content.map(c => c.type)
    : (typeof content === 'string' ? ['text'] : []);
  session.lastContentTypes = contentTypes;

  // Turn state must ignore the noise: 'attachment' and 'system' events fire
  // constantly (thousands per session) and would otherwise overwrite the last
  // real exchange, and sidechain events belong to subagents, not this turn.
  if (!event.isSidechain && (event.type === 'user' || event.type === 'assistant')) {
    const kind = classifyTurn(event, contentTypes, content);
    if (kind !== null) {
      session.lastTurnType = event.type;
      session.lastTurnContentTypes = contentTypes;
      session.lastTurnTools = Array.isArray(content)
        ? content.filter(c => c.type === 'tool_use').map(c => c.name).filter(Boolean)
        : [];
      session.lastTurnHandback = kind === 'handback';
      session.lastTurnAt = ts;
      if (event.type === 'user' && kind === 'pending' && !contentTypes.includes('tool_result')) {
        const asked = firstText(content).toLowerCase().slice(0, 2000);
        if (asked.trim()) {
          session.recentPrompts.push(asked);
          if (session.recentPrompts.length > 20) session.recentPrompts.shift();
        }
      }
    }
  }

  if (event.type === 'assistant' && msg.usage) {
    const msgId = msg.id;
    const usage = msg.usage;
    const seen = seenMessageIds.get(event.sessionId);

    if (msg.model) session.model = msg.model;

    // Track per-message-id usage, only count the delta
    const prev = seen.get(msgId) || { in: 0, out: 0, cacheCreate: 0, cacheRead: 0 };
    const curr = {
      in: usage.input_tokens || 0,
      out: usage.output_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };

    // Add only the difference (later events for same msgId have cumulative values)
    session.tokensIn += Math.max(0, curr.in - prev.in);
    session.tokensOut += Math.max(0, curr.out - prev.out);
    session.cacheCreationIn += Math.max(0, curr.cacheCreate - prev.cacheCreate);
    session.cacheReadIn += Math.max(0, curr.cacheRead - prev.cacheRead);

    seen.set(msgId, curr);

    // Track last turn's total input for context window estimate
    session.lastTurnInputTotal = curr.in + curr.cacheCreate + curr.cacheRead;

    // Recalculate cost
    const pricing = getPricing(session.model);
    session.costUSD =
      (session.tokensIn * pricing.input / 1_000_000) +
      (session.tokensOut * pricing.output / 1_000_000) +
      (session.cacheCreationIn * pricing.input * CACHE_WRITE_MULTIPLIER / 1_000_000) +
      (session.cacheReadIn * pricing.input * CACHE_READ_MULTIPLIER / 1_000_000);

    // Log tool use
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          addToRecentLog(session, {
            time: ts,
            type: 'tool',
            msg: block.name + (block.input?.file_path ? `: ${path.basename(block.input.file_path)}` : ''),
          });
        } else if (block.type === 'text' && block.text) {
          const snippet = block.text.substring(0, 120);
          addToRecentLog(session, { time: ts, type: 'think', msg: snippet });
        }
      }
      // Track active files. Which tool touched it matters: a file the session
      // wrote is a candidate for what you asked it to make, one it only read is
      // usually material.
      for (const block of content) {
        if (block.type !== 'tool_use' || !block.input) continue;
        const fp = block.input.file_path || block.input.notebook_path || block.input.path;
        if (!fp || typeof fp !== 'string' || !path.isAbsolute(fp)) continue;
        if (INTERNAL_PATH_RE.test(fp)) continue;
        const prev = session.fileTouches[fp] || { at: null, produced: false };
        session.fileTouches[fp] = {
          at: (!prev.at || ts > prev.at) ? ts : prev.at,
          produced: prev.produced || PRODUCING_TOOLS.has(block.name),
        };
      }
      // Keep the map from growing without bound; the ranking only needs recent work.
      const tracked = Object.keys(session.fileTouches);
      if (tracked.length > 200) {
        tracked
          .sort((a, b) => new Date(session.fileTouches[a].at || 0) - new Date(session.fileTouches[b].at || 0))
          .slice(0, tracked.length - 200)
          .forEach(p => { delete session.fileTouches[p]; });
      }
    }

    // Count turns by unique message IDs with stop_reason
    if (msg.stop_reason) {
      session.turnCount++;
    }
  }

  // --- Subagent tracking ---
  if (event.agentId && !event.agentId.startsWith('acompact')) {
    const aid = event.agentId;
    if (!session.subagents[aid]) {
      session.subagents[aid] = { agentId: aid, task: '', status: 'idle', tokensOut: 0, lastEventAt: null };
    }
    const sub = session.subagents[aid];
    sub.lastEventAt = ts;

    // Derive subagent status
    const subElapsed = Date.now() - new Date(ts).getTime();
    sub.status = subElapsed < 15_000 ? 'thinking' : 'idle';

    // Capture task from first user message
    if (!sub.task && event.type === 'user' && msg.role === 'user') {
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text : '');
      if (text) sub.task = text.substring(0, 120);
    }

    // Track subagent output tokens
    if (event.type === 'assistant' && msg.usage && msg.stop_reason) {
      sub.tokensOut += msg.usage.output_tokens || 0;
    }
  }

  if (event.type === 'user' && msg.role === 'user') {
    const text = typeof content === 'string'
      ? content.substring(0, 120)
      : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text?.substring(0, 120) : '');
    if (text) {
      addToRecentLog(session, { time: ts, type: 'user', msg: text });
    }
  }
}

// 'idle' used to mean two very different things: waiting for you, and gone.
// Now that liveness is known, a session with a running process is never idle —
// it has finished its turn and is waiting for input.
// Status comes from where the conversation stopped, not from how long ago.
// Thinking gaps of 20-30s are normal, so any elapsed-time window mislabels a
// working agent as done.
//
// The only shape that hands control back to the human is an assistant message
// that says something and calls nothing. Everything else mid-turn — a human
// prompt, a tool_result still to digest, a tool_use still running — means the
// agent owes a response.
//
// Known gap: an unanswered permission prompt looks exactly like a running
// tool. Claude Code does not write permission requests to the JSONL, so it is
// reported as 'thinking'. Tools that block on the human *are* named in the
// log, so those are caught — see BLOCKING_TOOLS.
// These tools hand control to the human and block until answered. Unlike a
// permission prompt they are ordinary tool_use blocks, so the log names them.
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function deriveStatus(session, liveInfo) {
  const isLive = !!liveInfo;
  const resting = isLive ? 'waiting' : 'idle';
  if (!session.lastEventAt) return resting;

  const elapsed = Date.now() - new Date(session.lastEventAt).getTime();
  if (elapsed < 60_000 && session.recentLog.slice(-3).some(l => l.type === 'error')) {
    return 'error';
  }

  // An explicit question outranks everything else: the agent stopped and is
  // blocked on you, no matter what is still churning in the background.
  if (session.lastTurnType === 'assistant'
      && (session.lastTurnTools || []).some(t => BLOCKING_TOOLS.has(t))) {
    return resting;
  }

  // Work is delegated and still in flight: a long job or a subagent fan-out.
  // The session carries on by itself, so it outranks thinking — it is neither
  // composing a reply nor blocked on you.
  if (isLive && liveInfo.busy) return 'running';

  // `claude --resume` writes nothing until you type, so a session restored
  // from a transcript that ended mid-turn would otherwise look like it is
  // still working on a prompt from days ago. A process younger than the last
  // exchange cannot be the one that was handling it — it just loaded the file
  // and is sitting at the prompt.
  if (isLive && session.lastTurnAt
      && liveInfo.startedMs > new Date(session.lastTurnAt).getTime() + RESUME_SKEW_MS) {
    return resting;
  }

  if (!session.lastTurnType) return resting;
  if (session.lastTurnHandback) return resting;

  // Mid-turn: still working if the process is there, died mid-turn if not.
  return isLive ? 'thinking' : 'idle';
}

// --- JSONL File Processing ---
function processFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const offset = fileOffsets.get(filePath) || 0;
  if (stat.size <= offset) return;

  // The project folder is the first segment under the watch root. Using the
  // parent directory instead breaks on subagent logs, which sit at
  // <hash>/<sessionId>/subagents/agent-*.jsonl and carry the parent's
  // sessionId — they would stamp every such session with 'subagents' and
  // make it unmatchable against any running process.
  const rel = path.relative(WATCH_DIR, filePath);
  const projectHash = (rel && !rel.startsWith('..'))
    ? rel.split(path.sep)[0]
    : path.basename(path.dirname(filePath));
  const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
  let buffer = '';

  stream.on('data', (chunk) => { buffer += chunk; });
  stream.on('end', () => {
    fileOffsets.set(filePath, stat.size);
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        processEvent(event, projectHash);
      } catch (e) {
        // Skip malformed lines (partial writes)
      }
    }
    // Only the session's own log counts, not its subagents': the name of a file
    // sitting directly in the project folder is the session id.
    const own = sessions.get(path.basename(filePath, '.jsonl'));
    if (own) own.logBytes = stat.size;
  });
}

// --- Live Session -> Terminal Resolution ---
// A dashboard session maps to a real terminal window through this chain:
//   session.projectHash  <=  encoded cwd of a running `claude` process
//   that process's tty   =>  the terminal emulator window holding that tty
// Claude Code does not keep the JSONL open, so the process table is the only
// reliable liveness signal (the /tmp session dirs persist long after exit).
const { execFileSync, execFile: execFileAsync } = require('child_process');

const TTY_PATH_RE = /^\/dev\/ttys[0-9]+$/;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

const TERMINAL_MATCHERS = [
  { re: /(^|\/)iTerm2?$/i, app: 'iTerm2' },
  { re: /(^|\/)iTermServer/i, app: 'iTerm2' },
  { re: /(^|\/)Terminal$/, app: 'Terminal' },
  { re: /(^|\/)ghostty$/i, app: 'Ghostty' },
  { re: /(^|\/)wezterm/i, app: 'WezTerm' },
  { re: /(^|\/)kitty$/i, app: 'kitty' },
  { re: /(^|\/)alacritty$/i, app: 'Alacritty' },
];
// Only these can be driven by AppleScript today; others fall back to the folder.
const RAISABLE = new Set(['iTerm2', 'Terminal']);

const LIVE_TTL_MS = 4000;
// A shell this old is no longer an ordinary tool call — it is a real job.
const BUSY_SHELL_MS = 30_000;
const SUBAGENT_ACTIVE_MS = 60_000;
// A workflow agent can think for minutes without writing, so its log needs a
// far more forgiving window than a plain subagent's. The journal is what keeps
// that from pinning a finished workflow at 'running'.
const WORKFLOW_AGENT_ACTIVE_MS = 10 * 60_000;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const SCAN_FILE_BUDGET = 600;
// ps reports elapsed time to the second and the scan is cached, so only treat
// a process as newer than the transcript when it is clearly newer.
const RESUME_SKEW_MS = 5000;
const SHELL_COMM_RE = /(^|\/)(zsh|bash|sh|fish)$/;

// ps prints elapsed time as [[DD-]HH:]MM:SS
function etimeSeconds(etime) {
  const m = String(etime).match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + (+m[4]);
}

// Depth-first, short-circuits on the first fresh file and never walks forever.
function hasRecentJsonl(root, withinMs) {
  const cutoff = Date.now() - withinMs;
  const stack = [root];
  let budget = SCAN_FILE_BUDGET;
  while (stack.length && budget > 0) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (budget-- <= 0) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { stack.push(full); continue; }
      if (!ent.name.endsWith('.jsonl')) continue;
      try { if (fs.statSync(full).mtimeMs >= cutoff) return true; } catch (e) { /* raced */ }
    }
  }
  return false;
}
let liveCache = { at: 0, byHash: new Map() };

// Claude Code derives its project dir name by replacing every non-alphanumeric
// character of the launch cwd with '-'. Verified against live sessions.
function encodeProjectHash(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function findTerminalApp(procs, pid) {
  let cur = procs.get(pid);
  for (let i = 0; i < 8 && cur; i++) {
    cur = procs.get(cur.ppid);
    if (!cur) break;
    for (const m of TERMINAL_MATCHERS) if (m.re.test(cur.comm)) return m.app;
  }
  return null;
}

// projectHash -> [{ pid, tty, cwd, terminal }]
function scanLiveClaudeProcs(force) {
  const now = Date.now();
  if (!force && now - liveCache.at < LIVE_TTL_MS) return liveCache.byHash;

  const byHash = new Map();
  if (process.platform !== 'win32') {
    try {
      // comm is used rather than args on purpose: command lines contain literal
      // newlines, which breaks any line-based parse of ps output.
      const psOut = execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,etime=,comm='], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024,
      });
      const procs = new Map();
      const childrenOf = new Map();
      const claudePids = [];
      for (const line of psOut.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const proc = { pid: m[1], ppid: m[2], tty: m[3], etime: m[4], comm: m[5].trim() };
        procs.set(proc.pid, proc);
        if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, []);
        childrenOf.get(proc.ppid).push(proc);
        if (proc.comm === 'claude' || proc.comm.endsWith('/claude')) claudePids.push(proc.pid);
      }

      if (claudePids.length) {
        const cwds = new Map();
        try {
          const lsofOut = execFileSync('lsof', ['-a', '-p', claudePids.join(','), '-d', 'cwd', '-Fpn'], {
            encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
          });
          let cur = null;
          for (const line of lsofOut.split('\n')) {
            if (line.startsWith('p')) cur = line.slice(1);
            else if (line.startsWith('n') && cur) { cwds.set(cur, line.slice(1)); cur = null; }
          }
        } catch (e) { /* no lsof -> no live detection, fall back to folder */ }

        for (const pid of claudePids) {
          const proc = procs.get(pid);
          const cwd = cwds.get(pid);
          if (!proc || !cwd) continue;
          const tty = '/dev/' + proc.tty;
          if (!TTY_PATH_RE.test(tty)) continue; // no controlling tty (daemon/agent)
          // A shell child of claude is a Bash tool call — foreground or
          // backgrounded. One that has outlived BUSY_SHELL_MS is a real job.
          // (MCP servers and hooks are node, so they never match.)
          const busyShell = (childrenOf.get(pid) || []).some(
            k => SHELL_COMM_RE.test(k.comm) && etimeSeconds(k.etime) * 1000 >= BUSY_SHELL_MS
          );
          const hash = encodeProjectHash(cwd);
          if (!byHash.has(hash)) byHash.set(hash, []);
          byHash.get(hash).push({
            pid, tty, cwd, busyShell,
            startedMs: now - etimeSeconds(proc.etime) * 1000,
            terminal: findTerminalApp(procs, pid),
          });
        }
      }
    } catch (e) { /* ps unavailable */ }
  }
  liveCache = { at: now, byHash };
  return byHash;
}

// The Workflow tool returns as soon as the run is queued, so the parent's turn
// ends and its own log goes quiet while the work continues. Its agents are the
// only evidence, and mtime alone is not enough: they write in bursts minutes
// apart, so a short window flickers, and a long one keeps a finished workflow
// alive on screen.
//
// The journal settles it. It records `started` and `result` per agentId, so an
// agent with no result is either working or was interrupted — and an
// interrupted run never gets its result, leaving entries that would otherwise
// read as running for days. Freshness of the agent's own log tells the two
// apart.
function hasRunningWorkflowAgent(subagentDir) {
  const workflowRoot = path.join(subagentDir, 'workflows');
  let entries;
  try { entries = fs.readdirSync(workflowRoot, { withFileTypes: true }); } catch (e) { return false; }

  const cutoff = Date.now() - WORKFLOW_AGENT_ACTIVE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(workflowRoot, entry.name);
    const journal = path.join(dir, 'journal.jsonl');

    let text;
    try {
      if (fs.statSync(journal).size > MAX_JOURNAL_BYTES) continue;
      text = fs.readFileSync(journal, 'utf8');
    } catch (e) { continue; }

    const started = new Set();
    const finished = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (e) { continue; }
      if (!ev.agentId) continue;
      if (ev.type === 'started') started.add(ev.agentId);
      else if (ev.type === 'result') finished.add(ev.agentId);
    }

    for (const agentId of started) {
      if (finished.has(agentId)) continue;
      try {
        if (fs.statSync(path.join(dir, 'agent-' + agentId + '.jsonl')).mtimeMs >= cutoff) return true;
      } catch (e) { /* the agent has not written yet */ }
    }
  }
  return false;
}

// sessionId -> { tty, terminal, pid, startedMs, busy, busyReason }
//
// A process is tied to a session by working directory, in two passes. The
// exact match comes first: a session resumed from a subdirectory keeps writing
// to the project folder it was first created in, so its folder name no longer
// encodes where it runs, and matching on the folder alone loses it. The folder
// encoding is the fallback, and still the only thing that works for a session
// whose recorded cwd has since moved.
//
// One process per session either way: where several could match, the most
// recently active takes it.
function resolveLiveSessions(force) {
  const byHash = scanLiveClaudeProcs(force);
  const live = new Map();
  if (!byHash.size) return live;

  const procs = [];
  for (const list of byHash.values()) for (const proc of list) procs.push(proc);

  const byRecency = [...sessions.values()]
    .sort((a, b) => new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0));
  const taken = new Set();

  function claim(proc, matches) {
    const s = byRecency.find(x => !taken.has(x.sessionId) && matches(x));
    if (!s) return false;
    taken.add(s.sessionId);
    // Subagents and workflow agents run in-process, so they spawn no shell —
    // their JSONL traffic is the only sign they are alive.
    const subagentDir = path.join(WATCH_DIR, s.projectHash, s.sessionId, 'subagents');
    const busyWorkflow = hasRunningWorkflowAgent(subagentDir);
    const busySubagents = !busyWorkflow && hasRecentJsonl(subagentDir, SUBAGENT_ACTIVE_MS);
    live.set(s.sessionId, {
      tty: proc.tty,
      terminal: proc.terminal,
      pid: Number(proc.pid),
      startedMs: proc.startedMs,
      busy: proc.busyShell || busyWorkflow || busySubagents,
      busyReason: busyWorkflow ? 'workflow'
        : busySubagents ? 'subagents'
        : proc.busyShell ? 'shell'
        : null,
    });
    return true;
  }

  const unmatched = procs.filter(proc => !claim(proc, s => s.cwd === proc.cwd));
  for (const proc of unmatched) {
    const hash = encodeProjectHash(proc.cwd);
    claim(proc, s => s.projectHash === hash);
  }
  return live;
}

// Window indices shift as soon as a window is activated, so read every property
// before selecting anything.
// Opens a new window and types one command into it. The command is passed as
// argv and never interpolated into the script source.
const LAUNCH_SCRIPTS = {
  iTerm2: `on run argv
  set theCommand to item 1 of argv
  tell application "iTerm2"
    set newWindow to (create window with default profile)
    try
      set zoomed of newWindow to true
    end try
    tell current session of newWindow
      write text theCommand
    end tell
    activate
  end tell
  return "LAUNCHED"
end run`,
  Terminal: `on run argv
  set theCommand to item 1 of argv
  tell application "Terminal"
    do script theCommand
    try
      set zoomed of front window to true
    end try
    activate
  end tell
  return "LAUNCHED"
end run`,
};

const RAISE_SCRIPTS = {
  iTerm2: `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is targetTty then
            select s
            select t
            select w
            activate
            return "RAISED"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "NOT_FOUND"
end run`,
  Terminal: `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is targetTty then
          set selected of t to true
          set frontmost of w to true
          activate
          return "RAISED"
        end if
      end repeat
    end repeat
  end tell
  return "NOT_FOUND"
end run`,
};

function raiseTerminal(terminal, tty, cb) {
  const script = RAISE_SCRIPTS[terminal];
  if (!script || !TTY_PATH_RE.test(tty)) return cb(new Error('unsupported'));
  // tty goes in as argv, never interpolated into the script source
  const child = execFileAsync('osascript', ['-', tty], { timeout: 8000 }, (err, stdout) => {
    if (err) return cb(err);
    if (!String(stdout).includes('RAISED')) return cb(new Error('tty-not-found'));
    cb(null);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(script);
}

// A dead session has no process to walk up from, so the terminal is chosen
// from whatever is currently running, preferring iTerm2.
function detectTerminalApp() {
  const byPreference = ['iTerm2', 'Terminal'];
  try {
    const out = execFileSync('ps', ['-axo', 'comm='], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024,
    });
    const running = out.split('\n').map(s => s.trim());
    for (const app of byPreference) {
      const matcher = TERMINAL_MATCHERS.find(m => m.app === app);
      if (running.some(c => c && matcher && matcher.re.test(c))) return app;
    }
  } catch (e) { /* fall through */ }
  return null;
}

// Single-quote for the shell; the only character that matters inside single
// quotes is the single quote itself.
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function launchInTerminal(terminal, command, cb) {
  const script = LAUNCH_SCRIPTS[terminal];
  if (!script) return cb(new Error('terminal-unsupported'));
  const child = execFileAsync('osascript', ['-', command], { timeout: 15000 }, (err, stdout) => {
    if (err) return cb(err);
    if (!String(stdout).includes('LAUNCHED')) return cb(new Error('launch-failed'));
    cb(null);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(script);
}

function openFolder(folder) {
  if (!folder || typeof folder !== 'string' || !fs.existsSync(folder)) return false;
  const plat = process.platform;
  if (plat === 'win32') execFileAsync('explorer', [folder.replace(/\//g, '\\')], () => {});
  else if (plat === 'darwin') execFileAsync('open', [folder], () => {});
  else execFileAsync('xdg-open', [folder], () => {});
  return true;
}

// --- Acknowledged ("seen") Sessions ---
// Jumping to a session that is waiting counts as reading it. The mark holds
// only while nothing has moved: the moment a new conversation event lands the
// human clearly engaged, so it is spent. Two hours is the backstop for the
// "not today" case, where the window is left open and untouched.
//
// Deliberately in memory: the mark is worth less than its own TTL, so
// persisting it across a watcher restart would buy nothing.
// Roughly where a log stops being a scratch conversation and starts being work
// worth finding again. Ten of this machine's thirty sessions clear it.
const SUBSTANTIAL_LOG_BYTES = 5 * 1024 * 1024;
const SEEN_TTL_MS = 2 * 60 * 60 * 1000;
const seenSessions = new Map(); // sessionId -> { at, turnAt }

function markSeen(sessionId) {
  const session = sessions.get(sessionId);
  seenSessions.set(sessionId, {
    at: Date.now(),
    turnAt: session ? session.lastTurnAt : null,
  });
}

function isSeen(session) {
  const ack = seenSessions.get(session.sessionId);
  if (!ack) return false;
  const moved = ack.turnAt !== session.lastTurnAt;
  if (moved || Date.now() - ack.at >= SEEN_TTL_MS) {
    seenSessions.delete(session.sessionId);
    return false;
  }
  return true;
}

// --- Express Server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/open-folder', express.json(), (req, res) => {
  const folder = req.body.path;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'No path' });
  if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Folder not found' });
  const { execFile } = require('child_process');
  const plat = process.platform;
  if (plat === 'win32') {
    execFile('explorer', [folder.replace(/\//g, '\\')], () => {});
  } else if (plat === 'darwin') {
    execFile('open', [folder], () => {});
  } else {
    execFile('xdg-open', [folder], () => {});
  }
  res.json({ ok: true });
});

// Click a session: jump to its terminal window if it is running, otherwise
// fall back to revealing its folder.
app.post('/api/focus-session', express.json(), (req, res) => {
  const sessionId = req.body && req.body.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Bad sessionId' });
  }
  const known = sessions.get(sessionId);
  const folder = (known && known.cwd) ||
    (typeof (req.body && req.body.path) === 'string' ? req.body.path : '');

  const info = resolveLiveSessions(true).get(sessionId);
  const fallback = (reason) => {
    if (openFolder(folder)) return res.json({ ok: true, action: 'folder', reason });
    return res.status(404).json({ error: 'Folder not found: ' + folder, reason });
  };

  if (!info) return fallback('not-running');
  if (!RAISABLE.has(info.terminal)) return fallback('terminal-unsupported:' + (info.terminal || 'unknown'));

  raiseTerminal(info.terminal, info.tty, (err) => {
    if (err) return fallback(err.message === 'tty-not-found' ? 'tty-not-found' : 'applescript-failed');
    markSeen(sessionId);
    res.json({ ok: true, action: 'raised', terminal: info.terminal, tty: info.tty });
  });
});

// Bring a session that is no longer running back up, in a new terminal
// window, resuming the same conversation rather than starting a blank one.
app.post('/api/resume-session', express.json(), (req, res) => {
  const sessionId = req.body && req.body.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return res.status(400).json({ error: 'Bad sessionId' });
  }
  const known = sessions.get(sessionId);
  if (!known) return res.status(404).json({ error: 'Unknown session' });

  // Refuse rather than start a second copy alongside a live one.
  if (resolveLiveSessions(true).has(sessionId)) {
    return res.status(409).json({ error: 'Session is already running' });
  }

  const cwd = known.cwd;
  let stat;
  try { stat = fs.statSync(cwd); } catch (e) { stat = null; }
  if (!stat || !stat.isDirectory()) {
    return res.status(404).json({ error: 'Working directory is gone: ' + cwd });
  }

  const terminal = detectTerminalApp();
  if (!terminal) return res.status(501).json({ error: 'No supported terminal is running' });

  const command = 'cd ' + shellQuote(cwd) + ' && claude --resume ' + shellQuote(sessionId);
  launchInTerminal(terminal, command, (err) => {
    if (err) return res.status(500).json({ error: 'Launch failed: ' + err.message });
    res.json({ ok: true, terminal, cwd });
  });
});

// Opening a file hands it to whatever the desktop registered for its type, so
// refuse the extensions where that means "run this".
const UNOPENABLE_RE = /\.(app|command|term|workflow|scpt|applescript|pkg|dmg|jar|action)$/i;

app.post('/api/open-file', express.json(), (req, res) => {
  const target = req.body && req.body.path;
  if (!target || typeof target !== 'string' || !path.isAbsolute(target)) {
    return res.status(400).json({ error: 'Bad path' });
  }
  if (UNOPENABLE_RE.test(target)) {
    return res.status(403).json({ error: 'Refusing to launch an executable bundle' });
  }
  let stat;
  try { stat = fs.statSync(target); } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) {
    return res.status(404).json({ error: 'File is gone' });
  }

  // execFileAsync, never a shell: the path is data, not part of a command line.
  const plat = process.platform;
  if (plat === 'darwin') execFileAsync('open', [target], () => {});
  else if (plat === 'win32') execFileAsync('cmd', ['/c', 'start', '', target], () => {});
  else execFileAsync('xdg-open', [target], () => {});
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  // Liveness first: it decides both the status and the click behaviour.
  const live = resolveLiveSessions(false);

  // Build list with derived status
  const all = [];
  for (const session of sessions.values()) {
    const info = live.get(session.sessionId);
    const status = deriveStatus(session, info);
    // Convert subagents object to sorted array, only include active ones
    const subagentList = Object.values(session.subagents)
      .filter(s => s.status === 'thinking')
      .sort((a, b) => new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0));
    const { fileTouches, recentPrompts, ...rest } = session;
    all.push({
      ...rest,
      activeFiles: rankFiles(session, 10),
      status,
      live: !!info,
      startedMs: info ? info.startedMs : null,
      contextWindow: getContextWindow(session.model, session.lastTurnInputTotal),
      seen: isSeen(session),
      busy: info ? !!info.busy : false,
      busyReason: info ? info.busyReason : null,
      tty: info ? info.tty : null,
      terminalApp: info ? info.terminal : null,
      pid: info ? info.pid : null,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      subagents: subagentList,
    });
  }

  // Everything is sent; `hidden` says what the page folds away by default, so
  // searching and the show-all toggle need no second request.
  //
  // A session is kept in view when it is running, when it is the most recent
  // one for its project, or when its log is big enough that it clearly holds
  // real work — losing a month-long conversation behind a five-minute one in
  // the same folder is the failure worth avoiding.
  const newestByLabel = new Map();
  for (const s of all) {
    const seen = newestByLabel.get(s.label);
    if (!seen || new Date(s.lastEventAt || 0) > new Date(seen.lastEventAt || 0)) {
      newestByLabel.set(s.label, s);
    }
  }
  for (const s of all) {
    s.hidden = !(
      s.live ||
      newestByLabel.get(s.label) === s ||
      (s.logBytes || 0) >= SUBSTANTIAL_LOG_BYTES
    );
  }

  // A folded card is not rendered until it is searched for or the toggle is
  // flipped, and its log is 40% of the payload. Drop it for those; the title,
  // the cost and the resume button are what make an old session findable.
  for (const s of all) {
    if (s.hidden) { s.recentLog = []; s.activeFiles = []; }
  }

  const result = all;
  // Sort: active today first (alphabetical), then inactive today (alphabetical)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Mark idle sessions not active today as 'idle-stale'
  for (const s of result) {
    if (s.status === 'idle' && (!s.lastEventAt || new Date(s.lastEventAt) < todayStart)) {
      s.status = 'idle-stale';
    }
  }
  // Running sessions hold the top of the page, in the order their terminals
  // were opened. That order does not move while they run, which matters more
  // than sorting them by anything: these are the cards being clicked, and a
  // list that reshuffles under the cursor every few seconds — as it would if
  // ordered by status or by last event — is worse than one that is merely not
  // ordered by urgency.
  //
  // Everything below them is ordered by how recently it was last spoken to,
  // so picking up yesterday's work means looking at the top of that group.
  result.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (a.live) {
      const byStart = (a.startedMs || 0) - (b.startedMs || 0);
      if (byStart) return byStart;
      return (a.label || '').localeCompare(b.label || '');
    }
    return new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0);
  });
  res.json(result);
});

// --- Start ---
const WATCH_DIR = path.join(os.homedir(), '.claude', 'projects');
const PORT = 3001;

console.log(`Watching: ${WATCH_DIR}`);
console.log(`Dashboard: http://localhost:${PORT}`);

// Watch the projects directory (chokidar v5 needs directory, not glob)
const watcher = chokidar.watch(WATCH_DIR, {
  persistent: true,
  ignoreInitial: false,
  depth: 4, // reach projects/hash/session/subagents/*.jsonl
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

function shouldProcessFile(filePath) {
  return filePath.endsWith('.jsonl') && !path.basename(filePath).includes('compact');
}
watcher.on('add', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});
watcher.on('change', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the existing process or use a different port.`);
    process.exit(1);
  }
  throw err;
});
