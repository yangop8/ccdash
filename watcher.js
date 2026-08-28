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
      recentLog: [],
      startedAt: null,
      lastEventAt: null,
      lastEventType: '',
      lastContentTypes: [],
      lastTurnType: '',        // 'user' | 'assistant' — main conversation only
      lastTurnContentTypes: [],
      lastTurnTools: [],
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

function addToRecentLog(session, entry) {
  session.recentLog.push(entry);
  if (session.recentLog.length > 30) {
    session.recentLog = session.recentLog.slice(-30);
  }
}

function extractActiveFiles(content) {
  const files = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      const fp = block.input.file_path || block.input.path || block.input.command;
      if (fp && typeof fp === 'string' && !fp.includes(' ')) {
        files.push(path.basename(fp));
      }
    }
  }
  return files;
}

function processEvent(event, projectHash) {
  if (!event || !event.sessionId) return;
  if (event.type === 'file-history-snapshot' || event.type === 'queue-operation' || event.type === 'last-prompt') return;

  const session = getOrCreateSession(event.sessionId);
  if (!event.timestamp) return; // skip events without timestamps
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;
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
  if (event.aiTitle) session.aiTitle = event.aiTitle;
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
    session.lastTurnType = event.type;
    session.lastTurnContentTypes = contentTypes;
    session.lastTurnTools = Array.isArray(content)
      ? content.filter(c => c.type === 'tool_use').map(c => c.name).filter(Boolean)
      : [];
    session.lastTurnAt = ts;
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
      // Track active files
      const newFiles = extractActiveFiles(content);
      if (newFiles.length) {
        const fileSet = new Set([...newFiles, ...session.activeFiles]);
        session.activeFiles = [...fileSet].slice(0, 10);
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

  if (!session.lastTurnType) return resting;

  const ct = session.lastTurnContentTypes || [];
  const turnFinished = session.lastTurnType === 'assistant'
    && ct.includes('text')
    && !ct.includes('tool_use');
  if (turnFinished) return resting;

  // Mid-turn: still working if the process is there, died mid-turn if not.
  return isLive ? 'thinking' : 'idle';
}

// --- JSONL File Processing ---
function processFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const offset = fileOffsets.get(filePath) || 0;
  if (stat.size <= offset) return;

  const projectHash = path.basename(path.dirname(filePath));
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
const SCAN_FILE_BUDGET = 600;
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
          byHash.get(hash).push({ pid, tty, cwd, busyShell, terminal: findTerminalApp(procs, pid) });
        }
      }
    } catch (e) { /* ps unavailable */ }
  }
  liveCache = { at: now, byHash };
  return byHash;
}

// sessionId -> { tty, terminal, pid }
// When a project has several running processes, the most recently active
// sessions take them in order — one process per session.
function resolveLiveSessions(force) {
  const byHash = scanLiveClaudeProcs(force);
  const live = new Map();
  if (!byHash.size) return live;

  const grouped = new Map();
  for (const s of sessions.values()) {
    if (!byHash.has(s.projectHash)) continue;
    if (!grouped.has(s.projectHash)) grouped.set(s.projectHash, []);
    grouped.get(s.projectHash).push(s);
  }
  for (const [hash, procList] of byHash) {
    const candidates = (grouped.get(hash) || [])
      .sort((a, b) => new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0));
    procList.forEach((proc, i) => {
      const s = candidates[i];
      if (!s) return;
      // Subagents and workflow agents run in-process, so they spawn no shell —
      // their JSONL traffic is the only sign they are alive.
      const subagentDir = path.join(WATCH_DIR, s.projectHash, s.sessionId, 'subagents');
      const busySubagents = hasRecentJsonl(subagentDir, SUBAGENT_ACTIVE_MS);
      live.set(s.sessionId, {
        tty: proc.tty,
        terminal: proc.terminal,
        pid: Number(proc.pid),
        busy: proc.busyShell || busySubagents,
        busyReason: proc.busyShell ? 'shell' : (busySubagents ? 'subagents' : null),
      });
    });
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
    all.push({
      ...session,
      status,
      live: !!info,
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

  // Active sessions (thinking/waiting/error) always shown individually.
  // Idle sessions: only show the most recent per project label.
  const active = all.filter(s => s.status !== 'idle');
  const idle = all.filter(s => s.status === 'idle');
  // Collect labels that already have an active session
  const activeLabels = new Set(active.map(s => s.label));
  const latestIdleByLabel = new Map();
  for (const s of idle) {
    // Skip idle sessions if that project already has an active session
    if (activeLabels.has(s.label)) continue;
    const existing = latestIdleByLabel.get(s.label);
    if (!existing || new Date(s.lastEventAt || 0) > new Date(existing.lastEventAt || 0)) {
      latestIdleByLabel.set(s.label, s);
    }
  }

  const result = [...active, ...latestIdleByLabel.values()];
  // Sort: active today first (alphabetical), then inactive today (alphabetical)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Mark idle sessions not active today as 'idle-stale'
  for (const s of result) {
    if (s.status === 'idle' && (!s.lastEventAt || new Date(s.lastEventAt) < todayStart)) {
      s.status = 'idle-stale';
    }
  }
  result.sort((a, b) => {
    const aToday = a.lastEventAt && new Date(a.lastEventAt) >= todayStart ? 1 : 0;
    const bToday = b.lastEventAt && new Date(b.lastEventAt) >= todayStart ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday; // active today first
    return (a.label || '').localeCompare(b.label || '');
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
