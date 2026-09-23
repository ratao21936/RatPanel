// ─────────────────────────────────────────────
//  CTRL Panel v3 (RatHost)
// ─────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Server: SocketIOServer } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const ProcessManager = require('./processManager');
const ConfigStore = require('./configStore');
const AuthManager = require('./authManager');
const Scheduler = require('./scheduler');
const WebhookManager = require('./webhookManager');
const registerFileManager = require('./fileManager');

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });
const io = new SocketIOServer(server, {
  path: '/socket.io/',
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 20006;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts' } });

const config = new ConfigStore(path.join(__dirname, 'processes.json'));
const auth = new AuthManager(path.join(__dirname, 'users.json'), process.env.JWT_SECRET);
const webhook = new WebhookManager(path.join(__dirname, 'webhook.json'));
const manager = new ProcessManager(config, webhook);
const scheduler = new Scheduler(path.join(__dirname, 'schedules.json'), manager);

registerFileManager(app, auth, manager, io);

// ── Tags store ────────────────────────────────
let tagsStore = {};
const tagsFile = path.join(__dirname, 'tags.json');
try { if (fs.existsSync(tagsFile)) tagsStore = JSON.parse(fs.readFileSync(tagsFile, 'utf-8')); } catch (_) { }
function saveTags() { fs.writeFileSync(tagsFile, JSON.stringify(tagsStore, null, 2)); }

// ── Notes store ───────────────────────────────
let notesStore = {};
const notesFile = path.join(__dirname, 'notes.json');
try { if (fs.existsSync(notesFile)) notesStore = JSON.parse(fs.readFileSync(notesFile, 'utf-8')); } catch (_) { }
function saveNotes() { fs.writeFileSync(notesFile, JSON.stringify(notesStore, null, 2)); }

// ── Groups store ──────────────────────────────
let groupsStore = [];
let groupMembersStore = {};
const groupsFile = path.join(__dirname, 'groups.json');
try {
  if (fs.existsSync(groupsFile)) {
    const raw = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
    if (Array.isArray(raw)) { groupsStore = raw; }
    else { groupsStore = raw.groups || []; groupMembersStore = raw.members || {}; }
  }
} catch (_) { }
function saveGroups() {
  fs.writeFileSync(groupsFile, JSON.stringify({ groups: groupsStore, members: groupMembersStore }, null, 2));
}

const uptimeHistory = {};
const UPTIME_MAX = 288;
const wsUsers = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1 && wsUsers.has(c)) c.send(msg); });
}

// ── Process events ────────────────────────────
manager.on('log', ({ id, line }) => broadcast({ event: 'log', id, line }));
manager.on('status', ({ id, status, pid }) => {
  broadcast({ event: 'status', id, status, pid });
  recordUptime(id, status);
  if (status === 'error') {
    const p = manager.procs[id];
    webhook.notify('crash', p?.name || id, `Process **${p?.name || id}** crashed and exited with an error.`);
  }
  if (status === 'running') {
    const p = manager.procs[id];
    if (p?._webhookStart) {
      webhook.notify('start', p.name, `Process **${p.name}** started (PID ${pid}).`);
      p._webhookStart = false;
    }
  }
});
manager.on('stats', ({ id, cpu, mem }) => broadcast({ event: 'stats', id, cpu, mem }));

wss.on('connection', (ws) => {
  const t = setTimeout(() => { if (!wsUsers.has(ws)) ws.close(); }, 10000);
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'auth') {
        const decoded = auth.verify(msg.token);
        if (!decoded || decoded.partial) { ws.send(JSON.stringify({ event: 'auth_failed' })); ws.close(); return; }
        clearTimeout(t);
        wsUsers.set(ws, decoded);
        ws.send(JSON.stringify({
          event: 'snapshot',
          processes: enrichProcesses(manager.getAll()),
          schedules: scheduler.list(),
          uptimeHistory,
          webhookConfig: webhook.getConfig(),
          user: decoded,
        }));
      }
    } catch (_) { }
  });
  ws.on('close', () => wsUsers.delete(ws));
});

io.on('connection', (socket) => {
  socket.on('disconnect', () => { });
});

function enrichProcesses(procs) {
  const procGroup = {};
  Object.entries(groupMembersStore).forEach(([gid, members]) => {
    (members || []).forEach(pid => { procGroup[pid] = gid; });
  });
  return procs.map(p => ({ ...p, tags: tagsStore[p.id] || [], notes: notesStore[p.id] || '', groupId: procGroup[p.id] || null }));
}

function recordUptime(id, status) {
  if (!uptimeHistory[id]) uptimeHistory[id] = [];
  uptimeHistory[id].push({ time: new Date().toISOString(), status });
  if (uptimeHistory[id].length > UPTIME_MAX) uptimeHistory[id].shift();
}

setInterval(() => {
  Object.values(manager.procs).forEach(p => {
    recordUptime(p.id, p.status);
    broadcast({ event: 'uptime_tick', id: p.id, history: uptimeHistory[p.id] });
  });
}, 5 * 60 * 1000);

// ── Auth routes ───────────────────────────────
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fields required' });
  const result = auth.login(username, password);
  if (!result) return res.status(401).json({ error: 'Invalid credentials' });
  res.json(result);
});

app.post('/api/auth/2fa/verify', loginLimiter, (req, res) => {
  const { partialToken, otp } = req.body;
  if (!partialToken || !otp) return res.status(400).json({ error: 'partialToken and otp required' });
  const result = auth.verify2fa(partialToken, otp);
  if (!result) return res.status(401).json({ error: 'Invalid code' });
  res.json(result);
});

app.get('/api/auth/me', auth.middleware(), (req, res) => {
  const me = auth.getPublicUser(req.user.id);
  if (!me) return res.status(404).json({ error: 'User not found' });
  res.json(me);
});

app.post('/api/auth/2fa/setup', auth.middleware(), async (req, res) => {
  try { res.json(await auth.begin2faSetup(req.user.id)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/2fa/confirm', auth.middleware(), (req, res) => {
  try { auth.confirm2faSetup(req.user.id, req.body.otp); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/2fa/disable', auth.middleware(), (req, res) => {
  try { auth.disable2fa(req.user.id, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Users ──────────────────────────────────────
app.get('/api/users', auth.middleware('manage_users'), (req, res) => res.json(auth.listUsers()));
app.get('/api/roles', auth.middleware(), (req, res) => res.json(AuthManager.getRoles()));

app.post('/api/users', auth.middleware('manage_users'), (req, res) => {
  try { res.status(201).json(auth.createUser(req.body.username, req.body.password, req.body.role)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/users/:id', auth.middleware('manage_users'), (req, res) => {
  try {
    if (req.params.id === req.user.id && req.body.role && req.body.role !== req.user.role) return res.status(403).json({ error: 'Cannot change own role' });
    res.json(auth.updateUser(req.params.id, req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/users/:id', auth.middleware('manage_users'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  try { auth.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Cor personalizada do RatHost — cada usuário muda só a própria (nenhuma permissão especial exigida)
app.patch('/api/user/color-theme', auth.middleware(), (req, res) => {
  try { res.json(auth.setColorTheme(req.user.id, req.body.colorTheme)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Processes ──────────────────────────────────
app.get('/api/processes', auth.middleware('view'), (req, res) => res.json(enrichProcesses(manager.getAll())));

app.get('/api/fs/browse', auth.middleware('view'), (req, res) => {
  const WIN = process.platform === 'win32';

  if (!req.query.path) {
    if (WIN) {
      const drives = ['C:\\', 'D:\\', 'E:\\', 'F:\\'].filter(d => {
        try { fs.accessSync(d); return true; } catch { return false; }
      });
      return res.json({ path: null, items: drives.map(d => ({ name: d, fullPath: d, type: 'drive' })) });
    } else {
      req.query.path = '/';
    }
  }

  const dirPath = req.query.path;
  const blocked = [/node_modules/i];
  if (blocked.some(r => r.test(dirPath))) return res.status(403).json({ error: 'Access denied' });

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const items = [];

    for (const e of entries) {
      try {
        const fullPath = path.join(dirPath, e.name);
        if (e.isDirectory()) {
          items.push({ name: e.name, fullPath, type: 'dir' });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          const runnable = ['.js', '.py', '.sh', '.bat', '.ps1', '.ts'].includes(ext);
          items.push({ name: e.name, fullPath, type: 'file', ext, runnable });
        }
      } catch (_) { }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const parent = dirPath !== path.parse(dirPath).root ? path.dirname(dirPath) : null;
    res.json({ path: dirPath, parent, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/processes', auth.middleware('add'), (req, res) => {
  const { name, type, path: sp, cwd, env, autoRestart, autoStart, description, customCmd, customArgs } = req.body;
  if (!name || !sp) return res.status(400).json({ error: 'name and path required' });
  try {
    const proc = manager.add({ id: uuidv4(), name, type: type || 'python', path: sp, cwd: cwd || path.dirname(sp), env: parseEnvStr(env || ''), autoRestart: autoRestart || 'never', autoStart: !!autoStart, description: description || '', port: req.body.port || null, customCmd: customCmd || null, customArgs: customArgs || null });
    if (req.body.tags) { tagsStore[proc.id] = req.body.tags; saveTags(); }
    if (req.body.notes) { notesStore[proc.id] = req.body.notes; saveNotes(); }
    const enriched = { ...proc, tags: tagsStore[proc.id] || [], notes: notesStore[proc.id] || '' };
    broadcast({ event: 'process_added', process: enriched });
    res.status(201).json(enriched);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/processes/:id', auth.middleware('delete'), (req, res) => {
  if (!manager.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
  delete tagsStore[req.params.id]; saveTags();
  delete notesStore[req.params.id]; saveNotes();
  Object.keys(groupMembersStore).forEach(gid => {
    groupMembersStore[gid] = (groupMembersStore[gid] || []).filter(pid => pid !== req.params.id);
  });
  saveGroups();
  broadcast({ event: 'process_removed', id: req.params.id });
  res.json({ ok: true });
});

app.patch('/api/processes/:id', auth.middleware('add'), (req, res) => {
  const body = { ...req.body };
  if (typeof body.env === 'string') body.env = parseEnvStr(body.env);
  const updated = manager.update(req.params.id, body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  broadcast({ event: 'process_updated', process: { ...updated, tags: tagsStore[req.params.id] || [] } });
  res.json(updated);
});

app.post('/api/processes/:id/start', auth.middleware('start'), async (req, res) => {
  const p = manager.procs[req.params.id];
  if (p) p._webhookStart = true;
  const r = await manager.start(req.params.id);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json(r);
});
app.post('/api/processes/:id/stop', auth.middleware('stop'), wrap(id => { webhook.notify('stop', manager.procs[id]?.name || id); return manager.stop(id); }));
app.post('/api/processes/:id/restart', auth.middleware('restart'), wrap(id => { webhook.notify('restart', manager.procs[id]?.name || id); return manager.restart(id); }));

app.get('/api/processes/:id/logs', auth.middleware('view'), (req, res) => {
  const logs = manager.getLogs(req.params.id, parseInt(req.query.lines) || 500);
  if (!logs) return res.status(404).json({ error: 'Not found' });
  res.json(logs);
});

app.get('/api/processes/:id/logs/export', auth.middleware('view'), (req, res) => {
  const logs = manager.getLogs(req.params.id, 2000);
  if (!logs) return res.status(404).json({ error: 'Not found' });
  const p = manager.procs[req.params.id];
  const name = p?.name || req.params.id;
  const text = logs.map(e => `[${e.time}] [${(e.level || 'info').toUpperCase()}] ${e.message}`).join('\n');
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-logs-${Date.now()}.txt"`);
  res.send(text);
});

app.post('/api/processes/:id/stdin', auth.middleware('start'), (req, res) => {
  if (!manager.sendStdin(req.params.id, req.body.command)) return res.status(400).json({ error: 'Not running' });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// TERMINAL — executa comando no diretório do bot
// ═══════════════════════════════════════════════
app.post('/api/processes/:id/exec', auth.middleware('start'), async (req, res) => {
  const id = req.params.id;
  const { command, cwd: customCwd } = req.body;
  const p = manager.procs[id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });
  if (!command) return res.status(400).json({ error: 'Comando obrigatório' });

  // Diretório: o cwd do bot, ou um custom passado
  const botDir = customCwd || p.cwd || (p.path ? path.dirname(p.path) : process.cwd());

  // Bloqueia comandos destrutivos
  const blocked = [/^rm\s+-rf\s+\/(?!home|root|var\/www|opt|tmp)/i, /^:\(\)\{/, /^mkfs/, /^dd\s+if=/];
  if (blocked.some(r => r.test(command))) {
    return res.status(403).json({ error: 'Comando bloqueado por segurança' });
  }

  const timeoutMs = 60000;
  exec(command, { cwd: botDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({
      ok: !err,
      code: err ? (err.code ?? -1) : 0,
      stdout: stdout || '',
      stderr: stderr || '',
      cwd: botDir,
      error: err && !stdout && !stderr ? err.message : null
    });
  });
});

// ═══════════════════════════════════════════════
// TERMINAL — lista arquivos do cwd do bot
// ═══════════════════════════════════════════════
app.get('/api/processes/:id/files', auth.middleware('view'), (req, res) => {
  const id = req.params.id;
  const p = manager.procs[id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });
  const dir = req.query.path || p.cwd || (p.path ? path.dirname(p.path) : process.cwd());
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => ({
      name: d.name,
      isDir: d.isDirectory()
    }));
    res.json({ cwd: dir, items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
// TOOL PANELS — Ports / Processes / Network
// ═══════════════════════════════════════════════

const IS_WIN = process.platform === 'win32';
const execAsync = (cmd, timeout = 4000) => new Promise((resolve) => {
  exec(cmd, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
    resolve({ ok: !err, stdout: stdout || '' });
  });
});

// ─── PORTAS ABERTAS DO PROCESSO ───
app.get('/api/processes/:id/ports', auth.middleware('view'), async (req, res) => {
  const p = manager.procs[req.params.id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });
  if (!p.pid) return res.json({ ports: [] });

  const pid = parseInt(p.pid, 10);
  if (!Number.isInteger(pid) || pid < 1) return res.json({ ports: [] });

  let cmd;
  if (IS_WIN) {
    cmd = `netstat -ano | findstr "${pid}"`;
  } else {
    cmd = `lsof -i -P -n -a -p ${pid} 2>/dev/null || ss -tlnp 2>/dev/null | grep "pid=${pid}"`;
  }

  const { stdout } = await execAsync(cmd);
  const ports = [];
  const seen = new Set();

  stdout.split('\n').forEach(line => {
    // Match portas tipo ":8080" ou ":8080 "
    const m = line.match(/:(\d{2,5})\b/);
    if (!m) return;
    const port = parseInt(m[1], 10);
    if (port < 1 || port > 65535 || seen.has(port)) return;
    seen.add(port);
    const listening = /LISTEN|listen/i.test(line);
    ports.push({
      port,
      protocol: /UDP/i.test(line) ? 'udp' : 'tcp',
      listening,
      pid: p.pid,
      process: p.name || 'unknown',
    });
  });

  res.json({ ports });
});

// ─── PROCESSOS FILHOS ───
app.get('/api/processes/:id/children', auth.middleware('view'), async (req, res) => {
  const p = manager.procs[req.params.id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });
  if (!p.pid) return res.json({ processes: [] });

  const pid = parseInt(p.pid, 10);
  if (!Number.isInteger(pid) || pid < 1) return res.json({ processes: [] });

  const treeMode = req.query.tree === '1';

  const processes = [{
    pid,
    command: p.name || p.path || 'main',
    user: '',
    cpu: p.cpu || '-',
    mem: p.mem || '-',
    depth: 0,
  }];

  let cmd;
  if (IS_WIN) {
    cmd = `wmic process where "ParentProcessId=${pid}" get ProcessId,CommandLine /format:csv 2>nul`;
  } else {
    cmd = `ps --ppid ${pid} -o pid,comm,user,%cpu,%mem --no-headers 2>/dev/null`;
  }

  const { stdout } = await execAsync(cmd);

  stdout.split('\n').forEach(line => {
    line = line.trim();
    if (!line) return;

    if (IS_WIN) {
      const parts = line.split(',');
      if (parts.length < 3) return;
      const cmdline = parts[1] || '';
      const childPid = parseInt(parts[2], 10);
      if (!Number.isInteger(childPid)) return;
      processes.push({
        pid: childPid,
        command: cmdline.slice(0, 120),
        user: '',
        cpu: '-',
        mem: '-',
        depth: treeMode ? 1 : 0,
      });
    } else {
      const parts = line.split(/\s+/);
      if (parts.length < 5) return;
      const childPid = parseInt(parts[0], 10);
      if (!Number.isInteger(childPid)) return;
      processes.push({
        pid: childPid,
        command: parts.slice(1, parts.length - 3).join(' ') || parts[1],
        user: parts[parts.length - 3] || '',
        cpu: (parts[parts.length - 2] || '-') + '%',
        mem: (parts[parts.length - 1] || '-') + '%',
        depth: treeMode ? 1 : 0,
      });
    }
  });

  res.json({ processes });
});

// ─── MATAR PROCESSO FILHO (admin) ───
app.post('/api/processes/:id/kill', auth.middleware('manage_settings'), async (req, res) => {
  const p = manager.procs[req.params.id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });

  const targetPid = parseInt(req.body.pid, 10);
  if (!Number.isInteger(targetPid) || targetPid < 1) {
    return res.status(400).json({ error: 'PID inválido' });
  }

  // Não permite matar o próprio processo principal por aqui
  // (pra isso existe o botão Stop)
  if (targetPid === p.pid) {
    return res.status(400).json({ error: 'Use o botão Stop para parar o processo principal' });
  }

  const cmd = IS_WIN
    ? `taskkill /PID ${targetPid} /F`
    : `kill -9 ${targetPid}`;

  const { ok, stdout } = await execAsync(cmd);
  if (!ok) return res.status(400).json({ error: 'Falha ao matar processo' });

  res.json({ ok: true, pid: targetPid, output: stdout });
});

// ─── CONEXÕES DE REDE DO PROCESSO ───
app.get('/api/processes/:id/network', auth.middleware('view'), async (req, res) => {
  const p = manager.procs[req.params.id];
  if (!p) return res.status(404).json({ error: 'Processo não encontrado' });
  if (!p.pid) return res.json({ connections: [], stats: null });

  const pid = parseInt(p.pid, 10);
  if (!Number.isInteger(pid) || pid < 1) return res.json({ connections: [], stats: null });

  let cmd;
  if (IS_WIN) {
    cmd = `netstat -ano | findstr "${pid}"`;
  } else {
    cmd = `ss -tupn 2>/dev/null | grep "pid=${pid}" || netstat -tupn 2>/dev/null | grep "${pid}/"`;
  }

  const { stdout } = await execAsync(cmd);
  const connections = [];

  stdout.split('\n').forEach(line => {
    line = line.trim();
    if (!line || /^Proto|^Active/i.test(line)) return;

    const parts = line.split(/\s+/);
    if (parts.length < 4) return;

    // Linux ss: Proto State Recv-Q Send-Q Local:Port Peer:Port Process
    // Windows netstat: Proto Local Foreign State PID
    let protocol, state, local, remote;

    if (IS_WIN) {
      protocol = (parts[0] || 'tcp').toLowerCase();
      local = parts[1] || '';
      remote = parts[2] || '';
      state = parts[3] || 'UNKNOWN';
    } else {
      protocol = (parts[0] || 'tcp').toLowerCase().replace(/[0-9]/g, '');
      state = (parts[1] || 'UNKNOWN').toUpperCase();
      local = parts[4] || parts[3] || '';
      remote = parts[5] || parts[4] || '';
    }

    connections.push({
      protocol: protocol.slice(0, 4),
      state,
      local,
      remote,
    });
  });

  // Stats fake por enquanto (você não coleta rx/tx no processManager)
  // Se quiser implementar de verdade, dá pra ler /proc/<pid>/net/dev no Linux
  const stats = {
    rx: '-',
    tx: '-',
  };

  res.json({ connections, stats });
});

app.post('/api/processes/:id/install', auth.middleware('start'), async (req, res) => {
  const id = req.params.id;
  const runtime = manager.procs[id];
  if (!runtime) return res.status(404).json({ error: 'Not found' });

  req.setTimeout(0);
  res.setTimeout(0);

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });

  const write = (type, text) => {
    if (closed) return;
    try { res.write(JSON.stringify({ type, text }) + '\n'); } catch (_) { }
  };

  const keepalive = setInterval(() => write('ping', ''), 5000);

  const result = await manager.installDeps(id, (type, text) => write(type, text));

  clearInterval(keepalive);
  write('done', result.ok
    ? '✅ Install completed successfully.'
    : `❌ Install failed (exit code ${result.code ?? 'unknown'}).`
  );
  if (!closed) res.end();
});

app.get('/api/processes/:id/uptime', auth.middleware('view'), (req, res) => res.json(uptimeHistory[req.params.id] || []));

app.patch('/api/processes/:id/tags', auth.middleware('add'), (req, res) => {
  tagsStore[req.params.id] = (req.body.tags || []).slice(0, 8).map(t => String(t).slice(0, 20));
  saveTags();
  broadcast({ event: 'tags_updated', id: req.params.id, tags: tagsStore[req.params.id] });
  res.json({ tags: tagsStore[req.params.id] });
});

app.patch('/api/processes/:id/notes', auth.middleware('add'), (req, res) => {
  notesStore[req.params.id] = String(req.body.notes || '').slice(0, 1000);
  saveNotes();
  broadcast({ event: 'notes_updated', id: req.params.id, notes: notesStore[req.params.id] });
  res.json({ notes: notesStore[req.params.id] });
});

app.post('/api/bulk/:action', auth.middleware('restart'), async (req, res) => {
  if (!['start', 'stop', 'restart'].includes(req.params.action)) return res.status(400).json({ error: 'Invalid' });
  res.json(await manager.bulkAction(req.params.action));
});

// ── Schedules ──────────────────────────────────
app.get('/api/schedules', auth.middleware('view'), (req, res) => res.json(scheduler.list()));
app.post('/api/schedules', auth.middleware('restart'), (req, res) => {
  try { const j = scheduler.add(req.body); broadcast({ event: 'schedule_added', job: j }); res.status(201).json(j); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/schedules/:id', auth.middleware('restart'), (req, res) => {
  if (!scheduler.remove(req.params.id)) return res.status(404).json({ error: 'Not found' });
  broadcast({ event: 'schedule_removed', id: req.params.id });
  res.json({ ok: true });
});
app.patch('/api/schedules/:id/toggle', auth.middleware('restart'), (req, res) => {
  try { const j = scheduler.toggle(req.params.id); broadcast({ event: 'schedule_updated', job: j }); res.json(j); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Groups ─────────────────────────────────────
app.get('/api/groups', auth.middleware('view'), (req, res) => {
  const result = groupsStore.map(g => ({
    ...g,
    memberCount: (groupMembersStore[g.id] || []).length,
    members: groupMembersStore[g.id] || [],
  }));
  res.json(result);
});

app.post('/api/groups', auth.middleware('add'), (req, res) => {
  const { name, color, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const group = { id: uuidv4(), name: String(name).slice(0, 40), color: color || '#c084fc', icon: icon || '📁' };
  groupsStore.push(group);
  groupMembersStore[group.id] = [];
  saveGroups();
  broadcast({ event: 'group_created', group: { ...group, members: [], memberCount: 0 } });
  res.status(201).json(group);
});

app.patch('/api/groups/:id', auth.middleware('add'), (req, res) => {
  const g = groupsStore.find(g => g.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  if (req.body.name !== undefined) g.name = String(req.body.name).slice(0, 40);
  if (req.body.color !== undefined) g.color = req.body.color;
  if (req.body.icon !== undefined) g.icon = req.body.icon;
  saveGroups();
  broadcast({ event: 'group_updated', group: { ...g, members: groupMembersStore[g.id] || [], memberCount: (groupMembersStore[g.id] || []).length } });
  res.json(g);
});

app.delete('/api/groups/:id', auth.middleware('delete'), (req, res) => {
  const idx = groupsStore.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  groupsStore.splice(idx, 1);
  delete groupMembersStore[req.params.id];
  saveGroups();
  broadcast({ event: 'group_deleted', id: req.params.id });
  res.json({ ok: true });
});

app.post('/api/groups/:id/members', auth.middleware('add'), (req, res) => {
  const g = groupsStore.find(g => g.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const ids = (req.body.processIds || []).filter(id => manager.procs[id]);
  groupMembersStore[g.id] = ids;
  groupsStore.forEach(other => {
    if (other.id !== g.id) {
      groupMembersStore[other.id] = (groupMembersStore[other.id] || []).filter(pid => !ids.includes(pid));
    }
  });
  saveGroups();
  broadcast({ event: 'group_updated', group: { ...g, members: ids, memberCount: ids.length } });
  res.json({ ok: true, members: ids });
});

app.post('/api/groups/:id/:action(start|stop|restart)', auth.middleware('restart'), async (req, res) => {
  const g = groupsStore.find(g => g.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Not found' });
  const members = groupMembersStore[g.id] || [];
  const action = req.params.action;
  const results = await Promise.all(members.map(pid => manager[action] ? manager[action](pid) : Promise.resolve({ ok: false })));
  res.json({ ok: true, results });
});

// ── Webhook settings ───────────────────────────
app.get('/api/webhook', auth.middleware('manage_settings'), (req, res) => res.json(webhook.getConfig()));
app.patch('/api/webhook', auth.middleware('manage_settings'), (req, res) => {
  try { res.json(webhook.save(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/webhook/test', auth.middleware('manage_settings'), async (req, res) => {
  const r = await webhook.test();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  RatHost on :${PORT}                    ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

process.on('SIGINT', async () => { await manager.stopAll(); process.exit(0); });

function wrap(fn) {
  return async (req, res) => {
    const r = await fn(req.params.id);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r);
  };
}
function parseEnvStr(str) {
  const env = {};
  str.split(/\s+/).forEach(p => { const [k, ...v] = p.split('='); if (k && v.length) env[k] = v.join('='); });
  return env;
}