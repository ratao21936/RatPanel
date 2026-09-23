// fileManager.js
// File Manager + Auto-deploy + Modo Raiz (com senha) + Trava de Edição
// + Delete Bot + Rename Bot + Duplicate Bot + Download + Zip Bot
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Pastas
const BOTS_DIR = path.resolve(__dirname, 'bots');
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ═══════════════════════════════════════════
// SEGURANÇA — MODO BOTS (só dentro de bots/)
// ═══════════════════════════════════════════
function safeResolve(userPath) {
  const resolved = path.resolve(BOTS_DIR, userPath || '');
  if (!resolved.startsWith(BOTS_DIR + path.sep) && resolved !== BOTS_DIR) {
    throw new Error('Acesso negado: caminho fora de bots/');
  }
  return resolved;
}

// ═══════════════════════════════════════════
// SEGURANÇA — MODO RAIZ (Linux inteiro, com bloqueios)
// ═══════════════════════════════════════════
const BLOCKED_PATHS = [
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/etc/shadow',
  '/etc/shadow-',
  '/etc/gshadow',
  '/etc/gshadow-',
  '/etc/passwd',
  '/etc/sudoers',
  '/root/.ssh',
  '/root/.gnupg',
  '/var/lib/docker',
  '/var/lib/pterodactyl',
  '/snap',
];

function safeResolveRoot(userPath) {
  const resolved = path.resolve('/', userPath || '/');

  for (const blocked of BLOCKED_PATHS) {
    if (resolved === blocked || resolved.startsWith(blocked + '/')) {
      throw new Error('Acesso negado a caminho crítico: ' + blocked);
    }
  }

  return resolved;
}

function resolvePath(p) {
  if (p && p.startsWith('/') && !p.startsWith(BOTS_DIR)) {
    return safeResolveRoot(p);
  }
  return safeResolve(p);
}

function isRootMode(p) {
  return p && p.startsWith('/') && !p.startsWith(BOTS_DIR);
}

// ═══════════════════════════════════════════
// CONTROLE DE MODO RAIZ (por usuário)
// ═══════════════════════════════════════════
const rootUnlocks = new Map();
const ROOT_UNLOCK_TTL = 30 * 60 * 1000; // 30 minutos

function isRootUnlocked(userId) {
  const entry = rootUnlocks.get(userId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    rootUnlocks.delete(userId);
    return false;
  }
  return true;
}

function unlockRoot(userId) {
  rootUnlocks.set(userId, {
    unlockedAt: Date.now(),
    expiresAt: Date.now() + ROOT_UNLOCK_TTL
  });
}

function lockRoot(userId) {
  rootUnlocks.delete(userId);
}

// ═══════════════════════════════════════════
// DETECÇÃO DE RUNTIME
// ═══════════════════════════════════════════
const NODE_ENTRIES = ['index.js', 'app.js', 'bot.js', 'main.js', 'server.js', 'start.js'];
const PY_ENTRIES = ['main.py', 'bot.py', 'app.py', 'index.py', 'start.py', '__main__.py'];

function detectRuntime(botDir) {
  const files = fs.readdirSync(botDir);
  const hasPackageJson = files.includes('package.json');
  const hasRequirements = files.includes('requirements.txt');
  const hasPyProject = files.includes('pyproject.toml');

  if (hasPackageJson) {
    let mgr = 'npm';
    if (files.includes('yarn.lock')) mgr = 'yarn';
    else if (files.includes('pnpm-lock.yaml')) mgr = 'pnpm';

    let entry = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(botDir, 'package.json'), 'utf8'));
      if (pkg.main && fs.existsSync(path.join(botDir, pkg.main))) {
        entry = pkg.main;
      } else if (pkg.scripts && pkg.scripts.start) {
        return { runtime: 'node', entry: null, useNpmStart: true, mgr };
      }
    } catch (_) {}

    if (!entry) entry = NODE_ENTRIES.find(f => files.includes(f));
    return { runtime: 'node', entry: entry || 'index.js', useNpmStart: false, mgr };
  }

  if (hasRequirements || hasPyProject) {
    const entry = PY_ENTRIES.find(f => files.includes(f));
    return { runtime: 'python', entry: entry || 'main.py', useNpmStart: false };
  }

  const pyFile = files.find(f => f.endsWith('.py'));
  if (pyFile) return { runtime: 'python', entry: pyFile, useNpmStart: false };

  const jsFile = files.find(f => f.endsWith('.js'));
  if (jsFile) return { runtime: 'node', entry: jsFile, useNpmStart: false };

  return { runtime: 'unknown', entry: null };
}

// ═══════════════════════════════════════════
// INSTALL DEPS
// ═══════════════════════════════════════════
function installDeps(botDir, runtime, mgr, onLog) {
  return new Promise((resolve) => {
    let cmd, args;

    if (runtime === 'node') {
      cmd = mgr || 'npm';
      args = ['install', '--no-audit', '--no-fund'];
    } else if (runtime === 'python') {
      if (!fs.existsSync(path.join(botDir, 'requirements.txt'))) {
        return resolve({ ok: true, skipped: true });
      }
      cmd = 'pip3';
      args = ['install', '--break-system-packages', '-r', 'requirements.txt'];
    } else {
      return resolve({ ok: true, skipped: true });
    }

    onLog && onLog('sys', `$ ${cmd} ${args.join(' ')}\n`);

    const proc = spawn(cmd, args, {
      cwd: botDir,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });

    proc.stdout.on('data', d => onLog && onLog('out', d.toString()));
    proc.stderr.on('data', d => onLog && onLog('err', d.toString()));

    proc.on('close', (code) => resolve({ ok: code === 0, code }));
    proc.on('error', (err) => {
      onLog && onLog('err', `Failed to spawn: ${err.message}\n`);
      resolve({ ok: false, code: -1 });
    });
  });
}

// ═══════════════════════════════════════════
// COPIAR PASTA (recursivo)
// ═══════════════════════════════════════════
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'venv' || entry.name === '.venv' || entry.name === '__pycache__') {
      continue;
    }

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ═══════════════════════════════════════════
// HELPER — verifica se um bot tá rodando
// ═══════════════════════════════════════════
function isBotRunning(botName, manager) {
  if (!manager) return false;
  const allProcs = manager.getAll();
  const botDir = path.join(BOTS_DIR, botName).replace(/\\/g, '/');

  return allProcs.some(p => {
    const procPath = (p.path || '').replace(/\\/g, '/');
    const procCwd = (p.cwd || '').replace(/\\/g, '/');
    const isRelated = p.name === botName || procPath.startsWith(botDir) || procCwd === botDir;
    return isRelated && (p.status === 'running' || p.status === 'starting');
  });
}

// ═══════════════════════════════════════════
// MODULE EXPORT
// ═══════════════════════════════════════════
module.exports = function registerFileManager(app, auth, manager, io) {
  const mw = (perm) => auth.middleware(perm || 'view');

  // ═══════════════════════════════════════════
  // ROTAS DE MODO RAIZ (unlock/lock/status)
  // ═══════════════════════════════════════════

  // UNLOCK — pede senha + valida role
  app.post('/api/fm/root-unlock', mw('view'), (req, res) => {
    try {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: 'Senha obrigatória' });

      // Verifica role
      const user = auth.users.find(u => u.id === req.user.id);
      if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

      if (user.role !== 'admin' && user.role !== 'operator') {
        return res.status(403).json({
          error: 'Acesso negado. Apenas operadores e admins podem desbloquear o modo raiz.'
        });
      }

      // Verifica senha
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Senha incorreta' });
      }

      unlockRoot(user.id);

      res.json({
        success: true,
        message: 'Modo raiz desbloqueado por 30 minutos',
        expiresIn: ROOT_UNLOCK_TTL
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // LOCK — volta a travar
  app.post('/api/fm/root-lock', mw('view'), (req, res) => {
    try {
      lockRoot(req.user.id);
      res.json({ success: true, message: 'Modo raiz bloqueado' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // STATUS — front consulta
  app.get('/api/fm/root-status', mw('view'), (req, res) => {
    try {
      const unlocked = isRootUnlocked(req.user.id);
      const entry = rootUnlocks.get(req.user.id);
      res.json({
        unlocked,
        expiresAt: entry ? entry.expiresAt : null,
        role: req.user.role
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // HELPER — check root mode bloqueado
  // ═══════════════════════════════════════════
  function checkRootAccess(req, rawPath) {
    if (isRootMode(rawPath) && !isRootUnlocked(req.user.id)) {
      const err = new Error('Modo raiz bloqueado. Desbloqueie primeiro digitando sua senha.');
      err.status = 403;
      throw err;
    }
  }

  // ═══════════════════════════════════════════
  // LISTAR
  // ═══════════════════════════════════════════
  app.get('/api/fm/list', mw('view'), (req, res) => {
    try {
      const rawPath = req.query.path || '';
      checkRootAccess(req, rawPath);

      const dir = resolvePath(rawPath);
      const baseDir = isRootMode(rawPath) ? '/' : BOTS_DIR;

      if (!fs.existsSync(dir)) return res.json([]);

      const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => {
        const full = path.join(dir, d.name);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { return null; }

        return {
          name: d.name,
          isDir: d.isDirectory(),
          size: stat.size,
          modified: stat.mtime,
          path: baseDir === '/' ? full : path.relative(BOTS_DIR, full).replace(/\\/g, '/')
        };
      }).filter(Boolean);

      res.json(items);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // LER
  // ═══════════════════════════════════════════
  app.get('/api/fm/read', mw('view'), (req, res) => {
    try {
      const rawPath = req.query.path;
      checkRootAccess(req, rawPath);

      const file = resolvePath(rawPath);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return res.status(400).json({ error: 'É uma pasta' });
      if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo muito grande (>5MB)' });
      res.json({ content: fs.readFileSync(file, 'utf8') });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // DOWNLOAD
  // ═══════════════════════════════════════════
  app.get('/api/fm/download', mw('view'), (req, res) => {
    try {
      const rawPath = req.query.path;
      checkRootAccess(req, rawPath);

      const file = resolvePath(rawPath);
      if (!fs.existsSync(file)) return res.status(404).json({ error: 'Arquivo não encontrado' });
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return res.status(400).json({ error: 'Não é um arquivo' });

      const name = path.basename(file);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // ESCREVER
  // ═══════════════════════════════════════════
  app.post('/api/fm/write', mw('add'), (req, res) => {
    try {
      const rawPath = req.body.path;
      checkRootAccess(req, rawPath);

      if (!isRootMode(rawPath)) {
        const botName = rawPath.split('/')[0];
        if (botName && isBotRunning(botName, manager)) {
          return res.status(423).json({ error: `Bot "${botName}" está rodando. Pare-o antes de editar.` });
        }
      }

      const target = resolvePath(rawPath);
      fs.writeFileSync(target, req.body.content, 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // CRIAR
  // ═══════════════════════════════════════════
  app.post('/api/fm/create', mw('add'), (req, res) => {
    try {
      const rawPath = req.body.path;
      checkRootAccess(req, rawPath);

      if (!isRootMode(rawPath)) {
        const botName = rawPath.split('/')[0];
        if (botName && isBotRunning(botName, manager)) {
          return res.status(423).json({ error: `Bot "${botName}" está rodando. Pare-o antes de criar.` });
        }
      }

      const target = resolvePath(rawPath);
      if (req.body.type === 'folder') fs.mkdirSync(target, { recursive: true });
      else fs.writeFileSync(target, '', 'utf8');
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // DELETAR
  // ═══════════════════════════════════════════
  app.delete('/api/fm/delete', mw('delete'), (req, res) => {
    try {
      const rawPath = req.query.path;
      checkRootAccess(req, rawPath);

      if (!isRootMode(rawPath)) {
        const botName = rawPath.split('/')[0];
        if (botName && isBotRunning(botName, manager)) {
          return res.status(423).json({ error: `Bot "${botName}" está rodando. Pare-o antes de deletar.` });
        }
      }

      const target = resolvePath(rawPath);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // RENOMEAR
  // ═══════════════════════════════════════════
  app.post('/api/fm/rename', mw('add'), (req, res) => {
    try {
      const rawPath = req.body.from;
      checkRootAccess(req, rawPath);
      checkRootAccess(req, req.body.to);

      if (!isRootMode(rawPath)) {
        const botName = rawPath.split('/')[0];
        if (botName && isBotRunning(botName, manager)) {
          return res.status(423).json({ error: `Bot "${botName}" está rodando. Pare-o antes de renomear.` });
        }
      }

      fs.renameSync(resolvePath(req.body.from), resolvePath(req.body.to));
      res.json({ success: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // STATUS DO BOT (pra travar edição)
  // ═══════════════════════════════════════════
  app.get('/api/fm/bot-status', mw('view'), (req, res) => {
    try {
      const botName = req.query.name;
      if (!botName) return res.status(400).json({ error: 'Nome obrigatório' });
      res.json({ running: isBotRunning(botName, manager) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════
  // DELETAR BOT COMPLETO
  // ═══════════════════════════════════════════
  app.post('/api/fm/delete-bot', mw('delete'), async (req, res) => {
    const botName = req.body.name;
    if (!botName) return res.status(400).json({ error: 'Nome obrigatório' });

    const targetDir = path.join(BOTS_DIR, botName);
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ error: 'Pasta do bot não encontrada' });
    }

    try {
      const removedProcs = [];
      if (manager) {
        const allProcs = manager.getAll();
        for (const p of allProcs) {
          const procPath = (p.path || '').replace(/\\/g, '/');
          const procCwd = (p.cwd || '').replace(/\\/g, '/');
          const target = targetDir.replace(/\\/g, '/');
          const isRelated = p.name === botName || procPath.startsWith(target) || procCwd === target;

          if (isRelated) {
            try { await manager.stop(p.id); } catch (_) {}
            try {
              if (manager.remove(p.id)) removedProcs.push(p.name);
            } catch (_) {}
          }
        }
      }

      fs.rmSync(targetDir, { recursive: true, force: true });

      if (io) {
        io.emit('upload-log', { bot: botName, type: 'sys', text: `🗑️ Bot "${botName}" deletado completamente\n` });
      }

      res.json({ success: true, name: botName, removedProcesses: removedProcs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // RENOMEAR BOT
  // ═══════════════════════════════════════════
  app.post('/api/fm/rename-bot', mw('add'), async (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName) return res.status(400).json({ error: 'Nomes obrigatórios' });
    if (!/^[a-z0-9_-]+$/i.test(newName)) return res.status(400).json({ error: 'Nome inválido' });

    const oldDir = path.join(BOTS_DIR, oldName);
    const newDir = path.join(BOTS_DIR, newName);

    if (!fs.existsSync(oldDir)) return res.status(404).json({ error: 'Bot original não existe' });
    if (fs.existsSync(newDir)) return res.status(400).json({ error: 'Já existe bot com esse nome' });
    if (isBotRunning(oldName, manager)) return res.status(423).json({ error: `Bot "${oldName}" está rodando. Pare-o antes de renomear.` });

    try {
      fs.renameSync(oldDir, newDir);

      const updatedProcs = [];
      if (manager) {
        const allProcs = manager.getAll();
        for (const p of allProcs) {
          const procPath = (p.path || '').replace(/\\/g, '/');
          const procCwd = (p.cwd || '').replace(/\\/g, '/');
          const oldTarget = oldDir.replace(/\\/g, '/');

          if (p.name === oldName || procPath.startsWith(oldTarget) || procCwd === oldTarget) {
            const relPath = path.relative(oldDir, p.path || p.cwd);
            const newPath = path.join(newDir, relPath);

            try {
              manager.update(p.id, {
                name: p.name === oldName ? newName : p.name,
                path: newPath,
                cwd: p.cwd === oldDir ? newDir : p.cwd
              });
              updatedProcs.push(p.name);
            } catch (_) {}
          }
        }
      }

      res.json({ success: true, oldName, newName, updatedProcesses: updatedProcs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // DUPLICAR BOT
  // ═══════════════════════════════════════════
  app.post('/api/fm/duplicate-bot', mw('add'), async (req, res) => {
    const { original, novo } = req.body;
    if (!original || !novo) return res.status(400).json({ error: 'Nomes obrigatórios' });
    if (!/^[a-z0-9_-]+$/i.test(novo)) return res.status(400).json({ error: 'Nome inválido' });

    const srcDir = path.join(BOTS_DIR, original);
    const destDir = path.join(BOTS_DIR, novo);

    if (!fs.existsSync(srcDir)) return res.status(404).json({ error: 'Bot original não existe' });
    if (fs.existsSync(destDir)) return res.status(400).json({ error: 'Já existe bot com esse nome' });

    try {
      copyDir(srcDir, destDir);
      res.json({ success: true, original, novo, path: destDir });
    } catch (e) {
      if (fs.existsSync(destDir)) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) {}
      }
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // ZIP BOT (download)
  // ═══════════════════════════════════════════
  app.get('/api/fm/zip-bot', mw('view'), (req, res) => {
    const botName = req.query.name;
    if (!botName) return res.status(400).json({ error: 'Nome obrigatório' });

    const botDir = path.join(BOTS_DIR, botName);
    if (!fs.existsSync(botDir)) return res.status(404).json({ error: 'Bot não existe' });

    try {
      const zip = new AdmZip();

      function addFolder(folderPath, zipPath) {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === 'venv' || entry.name === '.venv' || entry.name === '__pycache__') {
            continue;
          }
          const fullPath = path.join(folderPath, entry.name);
          const relPath = path.join(zipPath, entry.name);

          if (entry.isDirectory()) {
            addFolder(fullPath, relPath);
          } else {
            zip.addLocalFile(fullPath, zipPath);
          }
        }
      }

      addFolder(botDir, '');

      const buffer = zip.toBuffer();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${botName}.zip"`);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════
  // UPLOAD ZIP + AUTO-DEPLOY
  // ═══════════════════════════════════════════
  app.post('/api/fm/upload', mw('add'), upload.single('zip'), async (req, res) => {
    const botName = (req.body.name || '').trim();
    const zipPath = req.file?.path;
    const autoDeploy = req.body.autoDeploy !== 'false';
    const autoStart = req.body.autoStart === 'true';

    const envString = req.body.env || '';
    const env = {};
    envString.split(/\s+/).filter(Boolean).forEach(p => {
      const [k, ...v] = p.split('=');
      if (k && v.length) env[k] = v.join('=');
    });

    const emitLog = (type, text) => {
      if (io) io.emit('upload-log', { bot: botName, type, text });
    };

    if (!botName || !/^[a-z0-9_-]+$/i.test(botName)) {
      if (zipPath) fs.unlinkSync(zipPath);
      return res.status(400).json({ error: 'Nome inválido (use letras, números, - e _)' });
    }
    if (!zipPath) {
      return res.status(400).json({ error: 'Nenhum ZIP enviado' });
    }

    const targetDir = path.join(BOTS_DIR, botName);
    if (fs.existsSync(targetDir)) {
      fs.unlinkSync(zipPath);
      return res.status(400).json({ error: 'Já existe um bot com esse nome' });
    }

    try {
      emitLog('sys', `📦 Extraindo ZIP...\n`);
      const zip = new AdmZip(zipPath);
      const entries = zip.getEntries();

      const totalSize = entries.reduce((acc, e) => acc + e.header.size, 0);
      if (totalSize > 500 * 1024 * 1024) {
        fs.unlinkSync(zipPath);
        return res.status(400).json({ error: 'ZIP muito grande (possível zip bomb)' });
      }

      for (const entry of entries) {
        if (path.isAbsolute(entry.entryName) || entry.entryName.includes('..')) {
          fs.unlinkSync(zipPath);
          return res.status(400).json({ error: 'ZIP com caminhos inválidos' });
        }
      }

      fs.mkdirSync(targetDir, { recursive: true });
      zip.extractAllTo(targetDir, true);
      fs.unlinkSync(zipPath);
      emitLog('sys', `✅ Extraído em bots/${botName}\n`);

      const detection = detectRuntime(targetDir);
      emitLog('sys', `🔍 Runtime detectado: ${detection.runtime}${detection.entry ? ' (' + detection.entry + ')' : ''}\n`);

      emitLog('sys', `📥 Instalando dependências...\n`);
      const depResult = await installDeps(targetDir, detection.runtime, detection.mgr, emitLog);
      if (!depResult.skipped) {
        emitLog('sys', depResult.ok ? `✅ Dependências instaladas!\n` : `❌ Falha ao instalar (código ${depResult.code})\n`);
      } else {
        emitLog('sys', `ℹ️ Sem dependências pra instalar\n`);
      }

      let process = null;
      let processError = null;

      if (autoDeploy && manager && detection.runtime !== 'unknown') {
        try {
          const scriptPath = detection.useNpmStart
            ? targetDir
            : path.join(targetDir, detection.entry);

          const procType = detection.runtime === 'python'
            ? 'python'
            : (detection.useNpmStart ? 'npm_start' : 'node');

          process = manager.add({
            id: uuidv4(),
            name: botName,
            type: procType,
            path: scriptPath,
            cwd: targetDir,
            env: env,
            autoRestart: 'on-failure',
            autoStart: autoStart,
            description: 'Auto-deployed via ZIP upload',
            port: null,
            customCmd: null,
            customArgs: null,
          });

          emitLog('sys', `🎉 Processo "${botName}" criado na dashboard!\n`);

          if (autoStart) {
            emitLog('sys', `▶️ Iniciando bot...\n`);
            setTimeout(() => manager.start(process.id), 1000);
          }
        } catch (e) {
          processError = e.message;
          emitLog('err', `⚠️ Erro ao criar processo: ${e.message}\n`);
        }
      } else if (detection.runtime === 'unknown') {
        emitLog('err', `⚠️ Não foi possível detectar o tipo do bot (Python/Node). Arquivos criados, mas nenhum processo registrado.\n`);
      }

      res.json({
        success: true,
        name: botName,
        runtime: detection.runtime,
        entry: detection.entry,
        useNpmStart: detection.useNpmStart,
        deps: depResult,
        process: process,
        processError: processError,
      });
    } catch (e) {
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      emitLog('err', `❌ Erro: ${e.message}\n`);
      res.status(500).json({ error: 'Falha: ' + e.message });
    }
  });

  // ═══════════════════════════════════════════
  // LISTAR BOTS
  // ═══════════════════════════════════════════
  app.get('/api/fm/bots', mw('view'), (req, res) => {
    try {
      if (!fs.existsSync(BOTS_DIR)) return res.json([]);
      const bots = fs.readdirSync(BOTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => {
          const full = path.join(BOTS_DIR, d.name);
          const detection = detectRuntime(full);
          return {
            name: d.name,
            path: full,
            runtime: detection.runtime,
            entry: detection.entry,
            useNpmStart: detection.useNpmStart,
            running: isBotRunning(d.name, manager)
          };
        });
      res.json(bots);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════
  // PÁGINA HTML
  // ═══════════════════════════════════════════
  app.get('/fm', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'files.html'));
  });

  console.log('📁 File Manager + Auto-deploy + Modo Raiz (com senha) + Trava de Edição em /fm');
};