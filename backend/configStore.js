// ─────────────────────────────────────────────
//  ConfigStore
//  Persists process definitions to a JSON file
// ─────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._statusCache = {};
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      const defaults = [
        {
          id: 'example-1',
          name: 'ExampleBot',
          type: 'discord_py',
          path: '/path/to/your/bot/main.py',
          cwd: '/path/to/your/bot',
          env: { TOKEN: 'YOUR_BOT_TOKEN_HERE' },
          autoRestart: 'on-failure',
          description: 'Example Discord bot — edit path to your real bot',
        },
        {
          id: 'example-2',
          name: 'MyNodeApp',
          type: 'node',
          path: '/path/to/your/app/index.js',
          cwd: '/path/to/your/app',
          env: {},
          autoRestart: 'always',
          description: 'Example Node.js app',
        },
      ];
      this.save(defaults);
      return defaults;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      console.error('[Config] Failed to load:', err.message);
      return [];
    }
  }

  save(processes) {
    try {
      const toSave = processes.map(p => ({
        id:          p.id,
        name:        p.name,
        type:        p.type,
        path:        p.path,
        cwd:         p.cwd,
        env:         p.env || {},
        autoRestart: p.autoRestart || 'never',
        autoStart:   p.autoStart || false,
        port:        p.port || null,
        customCmd:   p.customCmd || null,
        customArgs:  p.customArgs || null,
        description: p.description || '',
      }));
      // Atomic write: write to temp then rename
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(toSave, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[Config] Failed to save:', err.message);
    }
  }

  updateStatus(id, status) {
    this._statusCache[id] = status;
  }
}

module.exports = ConfigStore;