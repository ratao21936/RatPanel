// ────────────────────────────────────────────
//  AuthManager v3
//  Multi-user roles + TOTP 2FA (speakeasy)
// ────────────────────────────────────────────
const fs       = require('fs');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const ROLES = {
  admin:    { label: 'Admin',    color: '#ff3b5c', can: ['view','start','stop','restart','add','delete','manage_users','manage_settings'] },
  operator: { label: 'Operator', color: '#ffb800', can: ['view','start','stop','restart','add'] },
  viewer:   { label: 'Viewer',   color: '#00d4ff', can: ['view'] },
};

const VALID_COLOR_THEMES = ['violet','red','cyan','navy','pink','green','orange','amber','teal','magenta'];

const pendingSecrets = {};

class AuthManager {
  constructor(filePath, jwtSecret) {
    this.filePath  = filePath;

    // ✅ Fail hard if JWT_SECRET is missing (no insecure fallback)
    if (!jwtSecret) {
      throw new Error(
        'JWT_SECRET is required. Set it in your .env file (e.g. JWT_SECRET=some-long-random-string).'
      );
    }
    if (jwtSecret.length < 16) {
      throw new Error('JWT_SECRET must be at least 16 characters.');
    }
    this.jwtSecret = jwtSecret;

    this.users     = [];
    this._load();

    if (this.users.length === 0) {
      console.log('\n[Auth] No users — creating default admin');
      console.log('[Auth] Username: admin  |  Password: admin123');
      console.log('[Auth] ⚠ Change this password after first login!\n');
      this.createUser('admin', 'admin123', 'admin');
    }
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try { this.users = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')); }
    catch (e) { console.error('[Auth] Load failed:', e.message); this.users = []; }
  }

  _save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.users, null, 2));
  }

  createUser(username, password, role = 'viewer') {
    if (!ROLES[role]) throw new Error(`Invalid role: ${role}`);
    if (this.users.find(u => u.username === username)) throw new Error('Username already exists');
    if (!username || username.length < 2) throw new Error('Username too short');
    if (!password || password.length < 6) throw new Error('Password min 6 chars');

    const user = {
      id: uuidv4(), username,
      password: bcrypt.hashSync(password, 10),
      role,
      colorTheme: 'violet',
      twoFaEnabled: false,
      twoFaSecret: null,
      createdAt: new Date().toISOString(),
      lastLogin: null,
    };
    this.users.push(user);
    this._save();
    return this._public(user);
  }

  updateUser(id, updates) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw new Error('User not found');
    if (updates.username) {
      if (this.users.find(u => u.username === updates.username && u.id !== id)) throw new Error('Username taken');
      user.username = updates.username;
    }
    if (updates.role) {
      if (!ROLES[updates.role]) throw new Error('Invalid role');
      user.role = updates.role;
    }
    if (updates.password) {
      if (updates.password.length < 6) throw new Error('Password min 6 chars');
      user.password = bcrypt.hashSync(updates.password, 10);
    }
    this._save();
    return this._public(user);
  }

  deleteUser(id) {
    const idx = this.users.findIndex(u => u.id === id);
    if (idx === -1) throw new Error('User not found');
    const admins = this.users.filter(u => u.role === 'admin');
    if (admins.length === 1 && admins[0].id === id) throw new Error('Cannot delete last admin');
    this.users.splice(idx, 1);
    this._save();
    return true;
  }

  setColorTheme(userId, colorTheme) {
    if (!VALID_COLOR_THEMES.includes(colorTheme)) throw new Error('Invalid color theme');
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    user.colorTheme = colorTheme;
    this._save();
    return this._public(user);
  }

  getPublicUser(id) {
    const user = this.users.find(u => u.id === id);
    if (!user) return null;
    return this._public(user);
  }

  listUsers() { return this.users.map(u => this._public(u)); }

  login(username, password) {
    const user = this.users.find(u => u.username === username);
    // Constant-time-ish: always run bcrypt even if user doesn't exist
    const hash = user ? user.password : '$2a$10$invalidhashinvalidhashinvalidhashinvalidhashinvalidh';
    const ok = bcrypt.compareSync(password, hash);
    if (!user || !ok) return null;

    if (user.twoFaEnabled) {
      const partial = jwt.sign(
        { id: user.id, username: user.username, role: user.role, partial: true },
        this.jwtSecret, { expiresIn: '5m' }
      );
      return { requires2fa: true, partialToken: partial };
    }

    return this._issueFullToken(user);
  }

  verify2fa(partialToken, otp) {
    let decoded;
    try { decoded = jwt.verify(partialToken, this.jwtSecret); }
    catch (_) { return null; }
    if (!decoded.partial) return null;

    const user = this.users.find(u => u.id === decoded.id);
    if (!user || !user.twoFaEnabled || !user.twoFaSecret) return null;

    const ok = speakeasy.totp.verify({
      secret:   user.twoFaSecret,
      encoding: 'base32',
      token:    String(otp).replace(/\s/g, ''),
      window:   1,
    });
    if (!ok) return null;

    return this._issueFullToken(user);
  }

  _issueFullToken(user) {
    user.lastLogin = new Date().toISOString();
    this._save();
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      this.jwtSecret, { expiresIn: '24h' }
    );
    return { token, user: this._public(user) };
  }

  async begin2faSetup(userId) {
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');

    const secret = speakeasy.generateSecret({ name: `CTRL Panel (${user.username})`, length: 20 });
    pendingSecrets[userId] = secret.base32;

    const qr = await QRCode.toDataURL(secret.otpauth_url);
    return { qr, secret: secret.base32 };
  }

  confirm2faSetup(userId, otp) {
    const secret = pendingSecrets[userId];
    if (!secret) throw new Error('No pending 2FA setup — start setup first');

    const ok = speakeasy.totp.verify({ secret, encoding: 'base32', token: String(otp).replace(/\s/g,''), window: 1 });
    if (!ok) throw new Error('Invalid code — try again');

    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    user.twoFaSecret  = secret;
    user.twoFaEnabled = true;
    delete pendingSecrets[userId];
    this._save();
    return true;
  }

  disable2fa(userId, password) {
    const user = this.users.find(u => u.id === userId);
    if (!user) throw new Error('User not found');
    if (!bcrypt.compareSync(password, user.password)) throw new Error('Wrong password');
    user.twoFaEnabled = false;
    user.twoFaSecret  = null;
    this._save();
    return true;
  }

  verify(token) {
    try { return jwt.verify(token, this.jwtSecret); }
    catch (_) { return null; }
  }

  middleware(permission) {
    return (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      const decoded = this.verify(auth.slice(7));
      if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
      if (decoded.partial) return res.status(401).json({ error: '2FA required' });
      if (permission && !ROLES[decoded.role]?.can.includes(permission)) return res.status(403).json({ error: 'Forbidden' });
      req.user = decoded;
      next();
    };
  }

  _public(user) {
    return {
      id:           user.id,
      username:     user.username,
      role:         user.role,
      roleLabel:    ROLES[user.role]?.label || user.role,
      roleColor:    ROLES[user.role]?.color || '#888',
      colorTheme:   user.colorTheme || 'violet',
      twoFaEnabled: user.twoFaEnabled || false,
      createdAt:    user.createdAt,
      lastLogin:    user.lastLogin,
    };
  }

  static getColorThemes() {
    return VALID_COLOR_THEMES;
  }

  static getRoles() {
    return Object.entries(ROLES).map(([key, val]) => ({ key, label: val.label, color: val.color, permissions: val.can }));
  }
}

module.exports = AuthManager;