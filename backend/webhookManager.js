  // ─────────────────────────────────────────────
//  WebhookManager
//  Discord webhook alerts for process events
// ─────────────────────────────────────────────
const fs    = require('fs');
const fetch = require('node-fetch');

const COLORS = {
  crash:   0xff3b5c,
  start:   0x00ff88,
  stop:    0xffb800,
  restart: 0x00d4ff,
  error:   0xff3b5c,
};

const EVENT_META = {
  crash: {
    emoji:  '💥',
    label:  'Process Crashed',
    status: '🔴 CRASHED',
    detail: (name) => `The process **${name}** has crashed unexpectedly and may require attention.`,
  },
  error: {
    emoji:  '⚠️',
    label:  'Runtime Error',
    status: '🔴 ERROR',
    detail: (name) => `An error was detected in **${name}**.`,
  },
  start: {
    emoji:  '▶️',
    label:  'Process Started',
    status: '🟢 ONLINE',
    detail: (name) => `**${name}** has started successfully and is now running.`,
  },
  stop: {
    emoji:  '⏹️',
    label:  'Process Stopped',
    status: '🟡 OFFLINE',
    detail: (name) => `**${name}** has been stopped.`,
  },
  restart: {
    emoji:  '🔄',
    label:  'Process Restarted',
    status: '🔵 RESTARTED',
    detail: (name) => `**${name}** has been restarted and is back online.`,
  },
};

// Only these hosts are allowed for webhook URLs
const ALLOWED_WEBHOOK_HOSTS = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];

class WebhookManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.config   = {
      webhookUrl:  '',
      events:      { crash: true, start: false, stop: false, restart: false },
      mentionRole: '',
    };
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      this.config = { ...this.config, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
    } catch (_) {}
  }

  save(updates) {
    // Validate webhook URL if provided
    if (updates.webhookUrl) {
      try {
        const u = new URL(updates.webhookUrl);
        if (!ALLOWED_WEBHOOK_HOSTS.includes(u.hostname)) {
          throw new Error(`Webhook host not allowed: ${u.hostname}`);
        }
        if (!u.pathname.startsWith('/api/webhooks/')) {
          throw new Error('Webhook path must start with /api/webhooks/');
        }
      } catch (e) {
        throw new Error(`Invalid webhook URL: ${e.message}`);
      }
    }

    // Validate events shape
    if (updates.events !== undefined) {
      if (typeof updates.events !== 'object' || Array.isArray(updates.events)) {
        throw new Error('events must be an object');
      }
    }

    this.config = { ...this.config, ...updates };
    fs.writeFileSync(this.filePath, JSON.stringify(this.config, null, 2));
    return this.config;
  }

  getConfig() {
    return { ...this.config };
  }

  async test() {
    const now = new Date();
    return this._send({
      color:       0x00d4ff,
      author:      { name: 'RatHost' },
      title:       '🔔  Webhook Connected',
      description: 'Your Discord webhook is configured correctly.\nYou\'ll receive alerts here for the events you have enabled.',
      fields: [
        { name: '✅  Status',         value: '`Connected & Working`', inline: true },
        { name: '🕐  Checked At',     value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: true },
        { name: '📋  Enabled Events', value: this._enabledEventsList(), inline: false },
      ],
      footer:    { text: 'RatHost  •  Rato' },
      timestamp: now.toISOString(),
    }, '');
  }

  async notify(event, processName, detail = '') {
    if (!this.config.webhookUrl) return;
    if (!this.config.events[event]) return;

    const meta    = EVENT_META[event] || { emoji: '🔔', label: event.toUpperCase(), status: event.toUpperCase(), detail: () => detail };
    const now     = new Date();
    const mention = this.config.mentionRole ? `<@&${this.config.mentionRole}>` : null;

    const embed = {
      color:  COLORS[event] || 0x7c3aed,
      author: { name: 'CTRL Panel  •  Process Monitor' },
      title:       `${meta.emoji}  ${processName}`,
      description: detail || meta.detail(processName),
      fields: [
        { name: '📌  Status', value: `\`${meta.status}\``, inline: true },
        { name: '🏷️  Event',  value: `\`${meta.label}\``,  inline: true },
        { name: '🕐  Time',   value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: true },
      ],
      footer:    { text: 'CTRL Panel v3  •  ctrl.panel' },
      timestamp: now.toISOString(),
    };

    return this._send(embed, mention);
  }

  async notifyMaxRestarts(processName, maxAttempts) {
    if (!this.config.webhookUrl) return;
    if (!this.config.events.crash) return;   // ✅ respects crash toggle

    const now = new Date();
    return this._send({
      color:  0xff3b5c,
      author: { name: 'CTRL Panel  •  Process Monitor' },
      title:  `💀  ${processName} — Gave Up Restarting`,
      description:
        `The process **${processName}** has failed to start **${maxAttempts} times in a row**.\n` +
        `Auto-restart has been **disabled** for this process to prevent a crash loop.\n\n` +
        `Please check the logs and fix the issue before restarting it manually.`,
      fields: [
        { name: '❌  Status',    value: '`STOPPED — TOO MANY CRASHES`', inline: true },
        { name: '🔁  Attempts',  value: `\`${maxAttempts} / ${maxAttempts}\``, inline: true },
        { name: '🕐  Time',      value: `<t:${Math.floor(now.getTime()/1000)}:F>`, inline: true },
        { name: '📋  Next Steps',
          value: '1. Open **CTRL Panel** and check the process logs\n2. Fix the underlying error\n3. Restart the process manually',
          inline: false,
        },
      ],
      footer:    { text: 'CTRL Panel v3  •  ctrl.panel' },
      timestamp: now.toISOString(),
    }, this.config.mentionRole ? `<@&${this.config.mentionRole}>` : '');
  }

  _enabledEventsList() {
    const { events } = this.config;
    const map = {
      crash:   '💥 Crash / Error',
      start:   '▶️ Start',
      stop:    '⏹️ Stop',
      restart: '🔄 Restart',
    };
    const enabled = Object.entries(map)
      .filter(([key]) => events[key])
      .map(([, label]) => `• ${label}`)
      .join('\n');
    return enabled || '_No events enabled_';
  }

  async _send(embed, mention = '') {
    if (!this.config.webhookUrl) return { ok: false, error: 'No webhook URL configured' };
    try {
      const payload = { embeds: [embed] };
      if (mention) payload.content = mention;

      const res = await fetch(this.config.webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) return { ok: false, error: `Discord returned ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = WebhookManager;