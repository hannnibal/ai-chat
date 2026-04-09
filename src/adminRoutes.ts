/**
 * 多账号 WhatsApp 管理 API + Web 页面
 *
 * GET    /admin                                → 管理页面（HTML）
 * GET    /api/v1/whatsapp/accounts             → 所有账号列表
 * POST   /api/v1/whatsapp/accounts             → 添加新账号
 * DELETE /api/v1/whatsapp/accounts/:id         → 删除账号
 * PATCH  /api/v1/whatsapp/accounts/:id         → 更新账号标签
 * POST   /api/v1/whatsapp/accounts/:id/connect → 使用已有 session 重连
 * POST   /api/v1/whatsapp/accounts/:id/relogin → 清除 session 并重新扫码
 * POST   /api/v1/whatsapp/accounts/:id/disconnect → 断开连接
 * POST   /api/v1/whatsapp/accounts/:id/logout  → 登出并清除 session
 * GET    /api/v1/whatsapp/events               → SSE 实时推送
 *
 * 兼容旧的单账号 API（用第一个已连接账号）：
 * GET    /api/v1/whatsapp/status               → 第一个账号状态
 * GET    /health                               → 健康检查
 */

import { Router, Request, Response } from 'express';
import {
  getAllAccounts,
  getAccount,
  addAccount,
  removeAccount,
  updateAccountLabel,
  updateAccountInboxId,
  reconnectAccountById,
  reloginAccountById,
  disconnectAccountById,
  logoutAccountById,
  subscribeSse,
  getFirstConnectedSocket,
} from './accountManager';
import { logger } from './logger';

const adminRouter = Router();

// ── 账号列表 ─────────────────────────────────────────────────
adminRouter.get('/api/v1/whatsapp/accounts', (_req: Request, res: Response) => {
  res.json({ accounts: getAllAccounts() });
});

// ── 添加账号 ─────────────────────────────────────────────────
adminRouter.post('/api/v1/whatsapp/accounts', (req: Request, res: Response) => {
  const { label, chatwoot_inbox_id } = req.body ?? {};
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const inboxId = chatwoot_inbox_id ? parseInt(chatwoot_inbox_id, 10) : undefined;
  const account = addAccount(label.trim(), inboxId && !isNaN(inboxId) ? inboxId : undefined);
  res.status(201).json(account);
});

// ── 删除账号 ─────────────────────────────────────────────────
adminRouter.delete('/api/v1/whatsapp/accounts/:id', async (req: Request, res: Response) => {
  const ok = await removeAccount(req.params.id);
  if (!ok) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json({ success: true });
});

// ── 更新账号信息（标签 / Inbox ID）──────────────────────────
adminRouter.patch('/api/v1/whatsapp/accounts/:id', (req: Request, res: Response) => {
  const { label, chatwoot_inbox_id } = req.body ?? {};
  if (!label && chatwoot_inbox_id === undefined) {
    res.status(400).json({ error: 'label or chatwoot_inbox_id is required' });
    return;
  }
  let account = null;
  if (label) {
    account = updateAccountLabel(req.params.id, label);
  }
  if (chatwoot_inbox_id !== undefined) {
    const inboxId = chatwoot_inbox_id === null || chatwoot_inbox_id === '' ? null : parseInt(chatwoot_inbox_id, 10);
    account = updateAccountInboxId(req.params.id, isNaN(inboxId as number) ? null : inboxId);
  }
  if (!account) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(account);
});

// ── 连接 ─────────────────────────────────────────────────────
adminRouter.post('/api/v1/whatsapp/accounts/:id/connect', async (req: Request, res: Response) => {
  try {
    await reconnectAccountById(req.params.id);
    res.json({ success: true, message: 'Reconnecting with saved session...' });
  } catch (err) {
    logger.error({ err }, 'Connect failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

adminRouter.post('/api/v1/whatsapp/accounts/:id/relogin', async (req: Request, res: Response) => {
  try {
    await reloginAccountById(req.params.id);
    res.json({ success: true, message: 'Generating a new QR code...' });
  } catch (err) {
    logger.error({ err }, 'Re-login failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── 断开连接 ─────────────────────────────────────────────────
adminRouter.post('/api/v1/whatsapp/accounts/:id/disconnect', async (req: Request, res: Response) => {
  try {
    await disconnectAccountById(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── 登出 ─────────────────────────────────────────────────────
adminRouter.post('/api/v1/whatsapp/accounts/:id/logout', async (req: Request, res: Response) => {
  try {
    await logoutAccountById(req.params.id);
    res.json({ success: true, message: 'Logged out and session cleared' });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── SSE 实时推送 ─────────────────────────────────────────────
adminRouter.get('/api/v1/whatsapp/events', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ accounts: getAllAccounts() })}\n\n`);
  const unsubscribe = subscribeSse((data: string) => { res.write(`data: ${data}\n\n`); });
  req.on('close', () => unsubscribe());
});

// ── 兼容旧 API ──────────────────────────────────────────────
adminRouter.get('/api/v1/whatsapp/status', (_req: Request, res: Response) => {
  const accounts = getAllAccounts();
  const connected = accounts.find(a => a.status === 'connected');
  res.json(connected ?? accounts[0] ?? { status: 'no_accounts' });
});

adminRouter.get('/health', (_req: Request, res: Response) => {
  const sock = getFirstConnectedSocket();
  res.json({
    status: 'ok',
    whatsapp: sock?.user ? 'connected' : 'disconnected',
    accounts: getAllAccounts().length,
    ts: new Date().toISOString(),
  });
});

// ── 管理页面 ─────────────────────────────────────────────────
adminRouter.get('/admin', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML);
});

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp Account Manager</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg-primary: #020617;
    --bg-card: #0F172A;
    --bg-card-hover: #1E293B;
    --bg-input: #0F172A;
    --border: #1E293B;
    --border-focus: #22C55E;
    --text-primary: #F8FAFC;
    --text-secondary: #94A3B8;
    --text-muted: #475569;
    --green: #22C55E;
    --green-dim: rgba(34,197,94,0.12);
    --blue: #3B82F6;
    --blue-dim: rgba(59,130,246,0.12);
    --amber: #F59E0B;
    --amber-dim: rgba(245,158,11,0.12);
    --red: #EF4444;
    --red-dim: rgba(239,68,68,0.12);
    --radius: 10px;
    --transition: 200ms ease;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
  body {
    font-family: 'Fira Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg-primary); color: var(--text-primary);
    min-height: 100vh; line-height: 1.5;
  }

  /* ── Layout ─────────────────────────────── */
  .shell { max-width: 960px; margin: 0 auto; padding: 32px 24px; }

  /* ── Header ─────────────────────────────── */
  .topbar {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 32px; flex-wrap: wrap; gap: 16px;
  }
  .topbar-title {
    display: flex; align-items: center; gap: 12px;
  }
  .topbar-icon {
    width: 36px; height: 36px; border-radius: 8px;
    background: var(--green-dim); display: flex; align-items: center; justify-content: center;
  }
  .topbar-icon svg { width: 20px; height: 20px; color: var(--green); }
  .topbar h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
  .topbar-sub { font-size: 13px; color: var(--text-muted); font-weight: 400; }

  /* ── Stats bar ──────────────────────────── */
  .stats {
    display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;
  }
  .stat {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 20px;
    flex: 1; min-width: 120px;
  }
  .stat-value { font-family: 'Fira Code', monospace; font-size: 22px; font-weight: 600; }
  .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-green .stat-value { color: var(--green); }
  .stat-amber .stat-value { color: var(--amber); }
  .stat-red .stat-value { color: var(--red); }

  /* ── Add form ───────────────────────────── */
  .add-bar {
    display: flex; gap: 10px; margin-bottom: 24px;
  }
  .add-input {
    flex: 1; padding: 10px 14px; font-size: 14px; font-family: 'Fira Sans', sans-serif;
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: var(--radius); color: var(--text-primary);
    transition: border-color var(--transition);
    outline: none;
  }
  .add-input::placeholder { color: var(--text-muted); }
  .add-input:focus { border-color: var(--border-focus); }

  /* ── Buttons ────────────────────────────── */
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; font-size: 13px; font-weight: 500;
    font-family: 'Fira Sans', sans-serif;
    border: 1px solid transparent; border-radius: var(--radius);
    cursor: pointer; transition: all var(--transition);
    outline: none; white-space: nowrap;
  }
  .btn:focus-visible { box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--green); }
  .btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .btn svg { width: 15px; height: 15px; }

  .btn-primary { background: var(--green); color: #020617; font-weight: 600; }
  .btn-primary:hover:not(:disabled) { background: #16A34A; }
  .btn-ghost { background: transparent; color: var(--text-secondary); border-color: var(--border); }
  .btn-ghost:hover:not(:disabled) { background: var(--bg-card-hover); color: var(--text-primary); }
  .btn-danger { background: transparent; color: var(--red); border-color: var(--red-dim); }
  .btn-danger:hover:not(:disabled) { background: var(--red-dim); }
  .btn-blue { background: var(--blue); color: #fff; }
  .btn-blue:hover:not(:disabled) { background: #2563EB; }

  /* ── Cards ──────────────────────────────── */
  .cards { display: flex; flex-direction: column; gap: 12px; }
  .card {
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px 24px;
    display: flex; align-items: flex-start; gap: 20px;
    transition: border-color var(--transition);
  }
  .card:hover { border-color: #334155; }
  .card-body { flex: 1; min-width: 0; }
  .card-visual { flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }

  .card-row-top { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .card-label { font-size: 16px; font-weight: 600; color: var(--text-primary); }
  .card-id { font-family: 'Fira Code', monospace; font-size: 11px; color: var(--text-muted); }
  .card-phone { font-family: 'Fira Code', monospace; font-size: 14px; color: var(--green); margin-top: 4px; }

  /* ── Status badge ───────────────────────── */
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 6px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
  }
  .badge-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
  }
  .badge-connected { background: var(--green-dim); color: var(--green); }
  .badge-connected .badge-dot { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .badge-qr_required { background: var(--amber-dim); color: var(--amber); }
  .badge-qr_required .badge-dot { background: var(--amber); }
  .badge-connecting { background: var(--blue-dim); color: var(--blue); }
  .badge-connecting .badge-dot { background: var(--blue); animation: pulse 1.2s ease-in-out infinite; }
  .badge-disconnected { background: var(--red-dim); color: var(--red); }
  .badge-disconnected .badge-dot { background: var(--red); }
  .badge-logged_out { background: var(--red-dim); color: var(--red); }
  .badge-logged_out .badge-dot { background: var(--red); }

  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* ── Card actions ───────────────────────── */
  .card-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .card-meta {
    display: flex; gap: 16px; margin-top: 10px;
    font-size: 11px; color: var(--text-muted);
    font-family: 'Fira Code', monospace;
  }
  .meta-ok { color: var(--green); }
  .meta-warn { color: var(--amber); }

  /* ── QR ─────────────────────────────────── */
  .qr-wrap {
    background: #fff; border-radius: 10px; padding: 12px;
    box-shadow: 0 0 20px rgba(34,197,94,0.08);
  }
  .qr-wrap img { width: 180px; height: 180px; display: block; }
  .qr-label { font-size: 11px; color: var(--text-muted); margin-top: 6px; text-align: center; }

  /* ── Spinner ────────────────────────────── */
  .spinner {
    width: 40px; height: 40px; border: 3px solid var(--border);
    border-top-color: var(--blue); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Connected visual ───────────────────── */
  .check-circle {
    width: 44px; height: 44px; border-radius: 50%;
    background: var(--green-dim); display: flex; align-items: center; justify-content: center;
  }
  .check-circle svg { width: 24px; height: 24px; color: var(--green); }

  /* ── Empty state ────────────────────────── */
  .empty {
    text-align: center; padding: 80px 20px;
    border: 1px dashed var(--border); border-radius: 12px;
  }
  .empty-icon { margin: 0 auto 16px; width: 48px; height: 48px; color: var(--text-muted); }
  .empty-title { font-size: 16px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
  .empty-hint { font-size: 13px; color: var(--text-muted); }

  /* ── Inbox ID ───────────────────────────── */
  .card-inbox {
    display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap;
  }
  .inbox-label {
    font-size: 12px; color: var(--text-muted); font-weight: 500;
  }
  .inbox-input {
    width: 100px; padding: 4px 8px; font-size: 13px;
    font-family: 'Fira Code', monospace;
    background: var(--bg-input); border: 1px solid var(--border);
    border-radius: 6px; color: var(--text-primary); outline: none;
    transition: border-color var(--transition);
  }
  .inbox-input:focus { border-color: var(--border-focus); }
  .inbox-input[readonly] {
    background: rgba(15, 23, 42, 0.45);
    color: var(--text-secondary);
    border-style: dashed;
    cursor: default;
  }
  .inbox-warn {
    font-size: 11px; color: var(--amber); font-weight: 500;
  }
  .btn-xs { padding: 4px 10px; font-size: 11px; }

  /* ── Responsive ─────────────────────────── */
  @media (max-width: 640px) {
    .topbar { flex-direction: column; align-items: flex-start; }
    .add-bar { flex-direction: column; }
    .card { flex-direction: column; }
    .card-visual { align-self: center; }
    .stats { flex-direction: column; }
  }
</style>
</head>
<body>
<div class="shell">

  <!-- Header -->
  <div class="topbar">
    <div class="topbar-title">
      <div class="topbar-icon">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      </div>
      <div>
        <h1>WhatsApp Accounts</h1>
        <div class="topbar-sub">Multi-account session manager</div>
      </div>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats" id="stats"></div>

  <!-- Add Account -->
  <div class="add-bar">
    <input class="add-input" id="new-label" placeholder="Account label, e.g. Sales Team" aria-label="New account label"
      onkeydown="if(event.key==='Enter')addAccount()" />
    <input class="add-input" id="new-inbox-id" placeholder="Chatwoot Inbox ID" aria-label="Chatwoot Inbox ID"
      onkeydown="if(event.key==='Enter')addAccount()" style="max-width:180px" />
    <button class="btn btn-primary" onclick="addAccount()">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Account
    </button>
  </div>

  <!-- Account Cards -->
  <div class="cards" id="accounts"></div>

</div>

<script>
const container = document.getElementById('accounts');
const statsEl = document.getElementById('stats');
const editingInboxIds = new Set();
const STATUS_LABELS = {
  disconnected: 'Disconnected', qr_required: 'Scan QR',
  connecting: 'Connecting', connected: 'Connected', logged_out: 'Logged Out',
};

// SVG icon helpers (inline Lucide icons)
const ICONS = {
  plug: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/></svg>',
  unplug: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 5 5 19"/><path d="M9 9H4.5a2 2 0 0 1 0-4H8"/><path d="M15 15h4.5a2 2 0 0 1 0 4H16"/></svg>',
  logOut: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  trash: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>',
  x: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  phone: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
};

function renderStats(accounts) {
  const total = accounts.length;
  const connected = accounts.filter(a => a.status === 'connected').length;
  const needsAuth = accounts.filter(a => a.status === 'qr_required' || a.status === 'logged_out' || a.status === 'disconnected').length;
  statsEl.innerHTML =
    '<div class="stat"><div class="stat-value">' + total + '</div><div class="stat-label">Total</div></div>' +
    '<div class="stat stat-green"><div class="stat-value">' + connected + '</div><div class="stat-label">Connected</div></div>' +
    (needsAuth > 0 ? '<div class="stat stat-amber"><div class="stat-value">' + needsAuth + '</div><div class="stat-label">Needs Auth</div></div>' : '');
}

function render(accounts) {
  window.__lastAccounts = accounts || [];
  renderStats(accounts || []);
  if (!accounts || accounts.length === 0) {
    container.innerHTML =
      '<div class="empty">' +
        '<div class="empty-icon">' + ICONS.phone + '</div>' +
        '<div class="empty-title">No accounts yet</div>' +
        '<div class="empty-hint">Add an account to get started</div>' +
      '</div>';
    return;
  }
  container.innerHTML = accounts.map(renderCard).join('');
}

function renderCard(a) {
  const s = a.status;
  const editingInbox = editingInboxIds.has(a.id);

  // Visual column
  let visual = '';
  if (s === 'qr_required' && a.qrDataUrl) {
    visual =
      '<div class="qr-wrap"><img src="' + a.qrDataUrl + '" alt="QR Code" /></div>' +
      '<div class="qr-label">Open WhatsApp &gt; Linked Devices</div>';
  } else if (s === 'connecting') {
    visual = '<div class="spinner" role="status" aria-label="Connecting"></div>';
  } else if (s === 'connected') {
    visual = '<div class="check-circle">' + ICONS.check + '</div>';
  }

  // Health info
  const healthAge = a.lastHealthCheck ? Math.round((Date.now() - new Date(a.lastHealthCheck).getTime()) / 1000) : null;
  const hClass = healthAge !== null && healthAge < 120 ? 'meta-ok' : 'meta-warn';
  const hText = healthAge !== null ? healthAge + 's ago' : '--';

  // Action buttons
  let actions = '';
  if (s === 'disconnected') {
    actions += '<button class="btn btn-blue" onclick="doConnect(&quot;' + a.id + '&quot;)">' + ICONS.plug + ' Reconnect</button>';
    actions += '<button class="btn btn-ghost" onclick="doRelogin(&quot;' + a.id + '&quot;)">' + ICONS.logOut + ' Re-login</button>';
  }
  if (s === 'logged_out') {
    actions += '<button class="btn btn-blue" onclick="doRelogin(&quot;' + a.id + '&quot;)">' + ICONS.plug + ' Scan QR</button>';
  }
  if (s === 'qr_required') {
    actions += '<button class="btn btn-ghost" onclick="doDisconnect(&quot;' + a.id + '&quot;)">' + ICONS.x + ' Cancel</button>';
  }
  if (s === 'connected') {
    actions += '<button class="btn btn-ghost" onclick="doDisconnect(&quot;' + a.id + '&quot;)">' + ICONS.unplug + ' Disconnect</button>';
    actions += '<button class="btn btn-danger" onclick="doLogout(&quot;' + a.id + '&quot;)">' + ICONS.logOut + ' Logout</button>';
  }
  actions += '<button class="btn btn-danger" onclick="doDelete(&quot;' + a.id + '&quot;)" style="margin-left:auto">' + ICONS.trash + '</button>';

  return '<div class="card">' +
    '<div class="card-body">' +
      '<div class="card-row-top">' +
        '<span class="card-label">' + esc(a.label) + '</span>' +
        '<span class="badge badge-' + s + '"><span class="badge-dot"></span>' + (STATUS_LABELS[s] || s) + '</span>' +
      '</div>' +
      '<div class="card-id">' + a.id + '</div>' +
      (a.phone ? '<div class="card-phone">+' + a.phone + '</div>' : '') +
      '<div class="card-inbox">' +
        '<span class="inbox-label">Inbox ID:</span> ' +
        '<input class="inbox-input" id="inbox-' + a.id + '" value="' + (a.chatwootInboxId || '') + '" placeholder="Not set" ' + (editingInbox ? '' : 'readonly') + ' />' +
        (
          editingInbox
            ? '<button class="btn btn-ghost btn-xs" onclick="saveInboxId(&quot;' + a.id + '&quot;)">Save</button>' +
              '<button class="btn btn-ghost btn-xs" onclick="cancelInboxEdit(&quot;' + a.id + '&quot;)">Cancel</button>'
            : '<button class="btn btn-ghost btn-xs" onclick="enableInboxEdit(&quot;' + a.id + '&quot;)">Edit</button>'
        ) +
        (!a.chatwootInboxId ? '<span class="inbox-warn">Messages will not be recorded</span>' : '') +
      '</div>' +
      '<div class="card-actions">' + actions + '</div>' +
      '<div class="card-meta">' +
        '<span>Health: <span class="' + hClass + '">' + hText + '</span></span>' +
        '<span>Updated: ' + new Date(a.updatedAt).toLocaleTimeString() + '</span>' +
      '</div>' +
    '</div>' +
    (visual ? '<div class="card-visual">' + visual + '</div>' : '') +
  '</div>';
}

function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── SSE ──────────────────────────────────
async function loadAccounts() {
  try {
    var res = await fetch('/api/v1/whatsapp/accounts');
    var data = await res.json();
    render(data.accounts || []);
  } catch (err) {
    console.error('Failed to load accounts', err);
  }
}

function connectSSE() {
  var es = new EventSource('/api/v1/whatsapp/events');
  es.onmessage = function(e) { try { render(JSON.parse(e.data).accounts); } catch(err) { console.error(err); } };
  es.onerror = function() { es.close(); setTimeout(connectSSE, 3000); };
}
loadAccounts();
connectSSE();

// ── API helpers ──────────────────────────
async function api(method, path, body) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  var res = await fetch(path, opts);
  var data = await res.json().catch(function() { return {}; });
  if (!res.ok) {
    throw new Error(data.error || data.message || ('Request failed: ' + res.status));
  }
  return data;
}

async function addAccount() {
  var input = document.getElementById('new-label');
  var inboxInput = document.getElementById('new-inbox-id');
  var label = input.value.trim();
  if (!label) { input.focus(); return; }
  input.disabled = true;
  inboxInput.disabled = true;
  try {
    var body = { label: label };
    var inboxVal = inboxInput.value.trim();
    if (inboxVal) body.chatwoot_inbox_id = inboxVal;
    await api('POST', '/api/v1/whatsapp/accounts', body);
    input.value = '';
    inboxInput.value = '';
    await loadAccounts();
    input.focus();
  } catch (err) {
    alert(err.message || 'Failed to add account');
  } finally {
    input.disabled = false;
    inboxInput.disabled = false;
  }
}

async function saveInboxId(id) {
  var input = document.getElementById('inbox-' + id);
  var val = input.value.trim();
  if (!confirm('Change Chatwoot Inbox ID for this account?')) return;
  try {
    await api('PATCH', '/api/v1/whatsapp/accounts/' + id, { chatwoot_inbox_id: val || null });
    editingInboxIds.delete(id);
    await loadAccounts();
  } catch (err) {
    alert(err.message || 'Failed to update inbox ID');
  }
}

function enableInboxEdit(id) {
  editingInboxIds.add(id);
  render(window.__lastAccounts || []);
  var input = document.getElementById('inbox-' + id);
  if (!input) return;
  input.focus();
  input.select();
}

function cancelInboxEdit(id) {
  editingInboxIds.delete(id);
  render(window.__lastAccounts || []);
}

async function doConnect(id) {
  try {
    await api('POST', '/api/v1/whatsapp/accounts/' + id + '/connect');
  } catch (err) {
    alert(err.message || 'Failed to reconnect account');
  }
}
async function doRelogin(id) {
  if (!confirm('This will clear the saved session and generate a new QR code. Continue?')) return;
  try {
    await api('POST', '/api/v1/whatsapp/accounts/' + id + '/relogin');
  } catch (err) {
    alert(err.message || 'Failed to re-login account');
  }
}
async function doDisconnect(id) {
  try {
    await api('POST', '/api/v1/whatsapp/accounts/' + id + '/disconnect');
  } catch (err) {
    alert(err.message || 'Failed to disconnect account');
  }
}
async function doLogout(id) {
  if (!confirm('This will clear the session. You will need to scan a new QR code. Continue?')) return;
  try {
    await api('POST', '/api/v1/whatsapp/accounts/' + id + '/logout');
  } catch (err) {
    alert(err.message || 'Failed to logout account');
  }
}
async function doDelete(id) {
  if (!confirm('Permanently delete this account? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/v1/whatsapp/accounts/' + id);
    await loadAccounts();
  } catch (err) {
    alert(err.message || 'Failed to delete account');
  }
}
</script>
</body>
</html>`;

export default adminRouter;
