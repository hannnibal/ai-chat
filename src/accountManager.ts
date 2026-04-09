/**
 * Multi-Account WhatsApp Manager
 *
 * 管理多个 WhatsApp 账号，每个账号独立的 Baileys socket 和 session 目录。
 * 支持：添加/删除账号、连接/断开/登出、定时授权检测、SSE 实时推送。
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
  getContentType,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { logger, baileysLogger } from './logger';
import {
  ConversationRoute,
  findOrCreateContact,
  findOrCreateConversation,
  createInboundMessage,
  createOutboundMessage,
  createMessageWithAttachment,
  formatAxiosError,
  invalidateConversationRoute,
  isConversationMissingError,
} from './chatwootClient';
import { loadConversationMappings, removeConversationMappingsForAccount } from './conversationMappingStore';

// ── 类型定义 ──────────────────────────────────────────────────

export type AccountStatus =
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'logged_out';

export interface AccountInfo {
  id: string;
  label: string;
  phone: string | null;
  status: AccountStatus;
  qrDataUrl: string | null;
  chatwootInboxId: number | null;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck: string | null;
}

interface AccountConfig {
  id: string;
  label: string;
  chatwootInboxId: number | null;
  createdAt: string;
}

interface AccountRuntime {
  config: AccountConfig;
  socket: ReturnType<typeof makeWASocket> | null;
  status: AccountStatus;
  phone: string | null;
  qrDataUrl: string | null;
  qrRaw: string | null;
  updatedAt: Date;
  lastHealthCheck: Date | null;
  processedMsgIds: Set<string>;
  phoneToJid: Map<string, string>;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  shuttingDown: boolean;
  connectionGeneration: number;
}

// ── 持久化路径 ────────────────────────────────────────────────
const DATA_DIR = path.resolve(config.wa.sessionDir, '..');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

// ── SSE ───────────────────────────────────────────────────────
const sseClients = new Set<(data: string) => void>();

function broadcast(): void {
  const payload = JSON.stringify({ accounts: getAllAccounts() });
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
}

export function subscribeSse(send: (data: string) => void): () => void {
  sseClients.add(send);
  return () => sseClients.delete(send);
}

// ── 账号存储 ──────────────────────────────────────────────────
const accounts = new Map<string, AccountRuntime>();

function loadAccountConfigs(): AccountConfig[] {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveAccountConfigs(): void {
  const configs = Array.from(accounts.values()).map(a => a.config);
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(configs, null, 2));
}

function getSessionDir(accountId: string): string {
  return path.resolve(DATA_DIR, `wa_session_${accountId}`);
}

function hasSavedSession(accountId: string): boolean {
  const sessionDir = getSessionDir(accountId);
  return fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
}

function clearReconnectTimer(rt: AccountRuntime): void {
  if (!rt.reconnectTimer) return;
  clearTimeout(rt.reconnectTimer);
  rt.reconnectTimer = null;
}

function scheduleReconnect(rt: AccountRuntime, delayMs: number): void {
  clearReconnectTimer(rt);
  const expectedGeneration = rt.connectionGeneration;
  rt.reconnectTimer = setTimeout(() => {
    rt.reconnectTimer = null;
    if (rt.connectionGeneration !== expectedGeneration) return;
    startConnection(rt).catch((err) => {
      logger.error({ err, accountId: rt.config.id }, 'Reconnect failed');
    });
  }, delayMs);
}

// ── 公开 API ──────────────────────────────────────────────────

export function getAllAccounts(): AccountInfo[] {
  return Array.from(accounts.values()).map(toAccountInfo);
}

export function getAccount(id: string): AccountInfo | null {
  const rt = accounts.get(id);
  return rt ? toAccountInfo(rt) : null;
}

function toAccountInfo(rt: AccountRuntime): AccountInfo {
  return {
    id: rt.config.id,
    label: rt.config.label,
    phone: rt.phone,
    status: rt.status,
    qrDataUrl: rt.qrDataUrl,
    chatwootInboxId: rt.config.chatwootInboxId,
    createdAt: rt.config.createdAt,
    updatedAt: rt.updatedAt.toISOString(),
    lastHealthCheck: rt.lastHealthCheck?.toISOString() ?? null,
  };
}

/** 添加新账号（不自动连接） */
export function addAccount(label: string, chatwootInboxId?: number): AccountInfo {
  const id = `wa_${Date.now().toString(36)}`;
  const cfg: AccountConfig = { id, label, chatwootInboxId: chatwootInboxId ?? null, createdAt: new Date().toISOString() };
  const rt: AccountRuntime = {
    config: cfg,
    socket: null,
    status: 'logged_out',
    phone: null,
    qrDataUrl: null,
    qrRaw: null,
    updatedAt: new Date(),
    lastHealthCheck: null,
    processedMsgIds: new Set(),
    phoneToJid: new Map(),
    reconnectTimer: null,
    shuttingDown: false,
    connectionGeneration: 0,
  };
  accounts.set(id, rt);
  saveAccountConfigs();
  broadcast();
  logger.info({ accountId: id, label }, 'Account added');
  return toAccountInfo(rt);
}

/** 删除账号（先断开连接） */
export async function removeAccount(id: string): Promise<boolean> {
  const rt = accounts.get(id);
  if (!rt) return false;

  await disconnectAccount(rt);
  const sessionDir = getSessionDir(id);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  accounts.delete(id);
  removeConversationMappingsForAccount(id);
  saveAccountConfigs();
  broadcast();
  logger.info({ accountId: id }, 'Account removed');
  return true;
}

/** 更新账号标签 */
export function updateAccountLabel(id: string, label: string): AccountInfo | null {
  const rt = accounts.get(id);
  if (!rt) return null;
  rt.config.label = label;
  saveAccountConfigs();
  broadcast();
  return toAccountInfo(rt);
}

/** 更新账号 Chatwoot Inbox ID */
export function updateAccountInboxId(id: string, inboxId: number | null): AccountInfo | null {
  const rt = accounts.get(id);
  if (!rt) return null;
  if (rt.config.chatwootInboxId !== inboxId) {
    removeConversationMappingsForAccount(id);
  }
  rt.config.chatwootInboxId = inboxId;
  saveAccountConfigs();
  broadcast();
  return toAccountInfo(rt);
}

/** 连接账号（启动 Baileys） */
export async function connectAccount(id: string): Promise<void> {
  const rt = accounts.get(id);
  if (!rt) throw new Error(`Account ${id} not found`);
  if (rt.status === 'connected' || rt.status === 'connecting') return;

  await startConnection(rt);
}

/** 使用已保存 session 重连；若无 session 则拒绝，避免误触发新二维码登录 */
export async function reconnectAccountById(id: string): Promise<void> {
  const rt = accounts.get(id);
  if (!rt) throw new Error(`Account ${id} not found`);
  if (rt.status === 'connected' || rt.status === 'connecting') return;
  if (!hasSavedSession(id)) {
    throw new Error('No saved session found; use re-login to generate a new QR code');
  }

  await startConnection(rt);
}

/** 强制重新登录：清除旧 session，再生成新的二维码 */
export async function reloginAccountById(id: string): Promise<void> {
  const rt = accounts.get(id);
  if (!rt) throw new Error(`Account ${id} not found`);

  clearReconnectTimer(rt);
  rt.connectionGeneration += 1;
  rt.shuttingDown = true;
  if (rt.socket) {
    try { rt.socket.end(undefined); } catch { /* ignore */ }
    rt.socket = null;
  }

  const sessionDir = getSessionDir(id);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  rt.status = 'logged_out';
  rt.phone = null;
  rt.qrDataUrl = null;
  rt.qrRaw = null;
  rt.updatedAt = new Date();
  broadcast();

  await startConnection(rt);
}

/** 断开账号（保留 session，下次可自动重连） */
export async function disconnectAccountById(id: string): Promise<void> {
  const rt = accounts.get(id);
  if (!rt) throw new Error(`Account ${id} not found`);
  await disconnectAccount(rt);
}

/** 登出账号（清除 session，需重新扫码） */
export async function logoutAccountById(id: string): Promise<void> {
  const rt = accounts.get(id);
  if (!rt) throw new Error(`Account ${id} not found`);

  clearReconnectTimer(rt);
  rt.connectionGeneration += 1;
  rt.shuttingDown = true;
  if (rt.socket) {
    try { await rt.socket.logout(); } catch { /* ok */ }
    rt.socket = null;
  }
  const sessionDir = getSessionDir(id);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  rt.status = 'logged_out';
  rt.phone = null;
  rt.qrDataUrl = null;
  rt.qrRaw = null;
  rt.updatedAt = new Date();
  broadcast();
  logger.info({ accountId: id }, 'Account logged out');
}

/** 发送消息（指定账号） */
export async function sendMessage(
  accountId: string,
  phone: string,
  text: string
): Promise<string> {
  const rt = accounts.get(accountId);
  if (!rt?.socket) throw new Error('WhatsApp not connected');

  const cleanPhone = phone.replace(/^\+/, '');
  const jid = rt.phoneToJid.get(cleanPhone) ?? `${cleanPhone}@s.whatsapp.net`;
  const result = await rt.socket.sendMessage(jid, { text });
  const msgId = result?.key?.id ?? '';
  logger.info({ accountId, phone, msgId }, 'Outbound WA message sent');
  return msgId;
}

/** 通过手机号查找对应的已连接账号（用于向特定号码发消息） */
export function findConnectedAccount(): AccountRuntime | null {
  for (const rt of accounts.values()) {
    if (rt.status === 'connected' && rt.socket) return rt;
  }
  return null;
}

/** 获取第一个已连接账号的 socket（兼容旧的单账号 API） */
export function getFirstConnectedSocket(): ReturnType<typeof makeWASocket> | null {
  const rt = findConnectedAccount();
  return rt?.socket ?? null;
}

// ── 内部实现 ──────────────────────────────────────────────────

async function disconnectAccount(rt: AccountRuntime): Promise<void> {
  clearReconnectTimer(rt);
  rt.connectionGeneration += 1;
  rt.shuttingDown = true;
  if (rt.socket) {
    rt.socket.end(undefined);
    rt.socket = null;
  }
  rt.status = hasSavedSession(rt.config.id) ? 'disconnected' : 'logged_out';
  rt.qrDataUrl = null;
  rt.qrRaw = null;
  rt.updatedAt = new Date();
  broadcast();
}

async function startConnection(rt: AccountRuntime): Promise<void> {
  const accountId = rt.config.id;
  const sessionDir = getSessionDir(accountId);
  clearReconnectTimer(rt);
  const generation = ++rt.connectionGeneration;
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  if (generation !== rt.connectionGeneration) return;

  const { version } = await fetchLatestBaileysVersion();
  if (generation !== rt.connectionGeneration) return;
  logger.info({ accountId, version }, 'Starting WhatsApp connection');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: baileysLogger.child({ accountId }) as never,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    shouldIgnoreJid: (jid: string) => !isDirectChatJid(jid),
  });

  if (generation !== rt.connectionGeneration) {
    try { sock.end(undefined); } catch { /* ignore */ }
    return;
  }

  rt.socket = sock;
  rt.shuttingDown = false;
  rt.status = 'connecting';
  rt.updatedAt = new Date();
  broadcast();

  // ── connection.update ─────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    if (generation !== rt.connectionGeneration) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      rt.qrRaw = qr;
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
      if (generation !== rt.connectionGeneration) return;
      rt.qrDataUrl = qrDataUrl;
      rt.status = 'qr_required';
      rt.updatedAt = new Date();
      broadcast();
      logger.info({ accountId }, 'QR code generated');
    }

    if (connection === 'open') {
      rt.phone = sock.user?.id?.split(':')[0] ?? null;
      rt.status = 'connected';
      rt.qrDataUrl = null;
      rt.qrRaw = null;
      rt.updatedAt = new Date();
      rt.lastHealthCheck = new Date();
      broadcast();
      logger.info({ accountId, phone: rt.phone }, 'WhatsApp connected');
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const errorMsg = (lastDisconnect?.error as Boom)?.message ?? 'unknown';
      rt.socket = null;

      if (rt.shuttingDown) {
        rt.status = hasSavedSession(accountId) ? 'disconnected' : 'logged_out';
        rt.updatedAt = new Date();
        broadcast();
        logger.info({ accountId }, 'Connection closed during intentional shutdown');
        return;
      }

      logger.warn({ accountId, statusCode, errorMsg }, 'Connection closed');

      if (statusCode === DisconnectReason.loggedOut || statusCode === 403 || statusCode === 405) {
        // 被服务器踢出：清除 session，等待用户手动重新连接
        logger.warn({ accountId, statusCode }, 'Session rejected, clearing. Use admin panel to reconnect.');
        const dir = getSessionDir(accountId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        rt.status = 'logged_out';
        rt.phone = null;
        rt.qrDataUrl = null;
        rt.updatedAt = new Date();
        broadcast();
        // 不自动重连，避免被服务器限流导致死循环
        // 用户需要在 admin 页面手动点击「连接」按钮重新扫码
      } else if (statusCode === 408) {
        // QR 超时：自动刷新
        rt.status = 'disconnected';
        rt.updatedAt = new Date();
        broadcast();
        scheduleReconnect(rt, 3000);
      } else if (
        statusCode === DisconnectReason.connectionClosed ||
        statusCode === DisconnectReason.connectionLost ||
        statusCode === DisconnectReason.connectionReplaced ||
        statusCode === DisconnectReason.timedOut ||
        statusCode === DisconnectReason.restartRequired
      ) {
        // 可恢复的断线：保留 session，快速重连
        rt.status = 'disconnected';
        rt.updatedAt = new Date();
        broadcast();
        const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
        logger.info({ accountId, statusCode }, `Recoverable disconnect, reconnecting in ${delay}ms...`);
        scheduleReconnect(rt, delay);
      } else {
        // 未知断线：保留 session，稍慢重连
        rt.status = 'disconnected';
        rt.updatedAt = new Date();
        broadcast();
        logger.warn({ accountId, statusCode }, 'Unexpected disconnect, reconnecting in 10s...');
        scheduleReconnect(rt, 10_000);
      }
    }

    if (connection === 'connecting') {
      rt.status = 'connecting';
      rt.updatedAt = new Date();
      broadcast();
    }
  });

  // ── creds.update ──────────────────────────────────────────
  sock.ev.on('creds.update', () => {
    if (generation !== rt.connectionGeneration) return;
    fs.mkdirSync(sessionDir, { recursive: true });
    void saveCreds().catch((err) => {
      if (generation !== rt.connectionGeneration) return;
      logger.warn({ err, accountId, sessionDir }, 'Failed to persist WhatsApp session credentials');
    });
  });

  // ── messages.upsert ───────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const msgId = msg.key.id ?? '';
      if (rt.processedMsgIds.has(msgId)) continue;
      rt.processedMsgIds.add(msgId);

      // 防止 Set 无限增长
      if (rt.processedMsgIds.size > 5000) {
        const iter = rt.processedMsgIds.values();
        for (let i = 0; i < 1000; i++) iter.next();
        // 删除最早的 1000 条
        const arr = Array.from(rt.processedMsgIds);
        for (let i = 0; i < 1000; i++) rt.processedMsgIds.delete(arr[i]);
      }

      const isFromMe = msg.key.fromMe ?? false;
      const jid = msg.key.remoteJid ?? '';
      if (!jid || jid === 'status@broadcast') continue;
      if (!isDirectChatJid(jid)) {
        logger.info({ accountId, jid, msgId }, 'Skipping non-direct WhatsApp chat');
        continue;
      }
      const phone = jid.split('@')[0];
      rt.phoneToJid.set(phone, jid);
      const pushName = msg.pushName ?? phone;

      try {
        const parsed = await parseMessage(msg, sock);
        if (!parsed) continue;

        logger.info(
          { accountId, phone, msgId, type: parsed.type, fromMe: isFromMe, text: parsed.text?.slice(0, 50) },
          isFromMe ? 'Outbound WA message captured' : 'Inbound WA message'
        );

        const inboxId = rt.config.chatwootInboxId;
        if (!inboxId) {
          logger.warn({ accountId, phone }, 'No Chatwoot Inbox ID configured, skipping message');
          continue;
        }
        await forwardToChatwoot(accountId, phone, pushName, parsed, msgId, isFromMe, inboxId);
      } catch (err) {
        logger.error(
          { ...formatAxiosError(err), accountId, phone, msgId },
          'Failed to forward message to Chatwoot'
        );
      }
    }
  });

  // ── call 事件 ─────────────────────────────────────────────
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      const jid = call.from;
      const phone = jid.split('@')[0];
      const callType = call.isVideo ? '📹 视频通话' : '📞 语音通话';
      if (call.status === 'offer' || call.status === 'ringing') {
        const callMsgId = `call_${call.id}_${Date.now()}`;
        if (rt.processedMsgIds.has(callMsgId)) continue;
        rt.processedMsgIds.add(callMsgId);
        const text = `[${callType}] 收到来电`;
        logger.info({ accountId, phone, callId: call.id }, 'Incoming call detected');
        try {
          const inboxId = rt.config.chatwootInboxId;
          if (!inboxId) {
            logger.warn({ accountId, phone }, 'No Chatwoot Inbox ID configured, skipping call');
            continue;
          }
          const contactId = await findOrCreateContact(phone, phone, inboxId);
          const conversationId = await findOrCreateConversation(contactId, phone, inboxId, {
            accountId,
            inboxId,
            peerId: phone,
          });
          await createInboundMessage(conversationId, text, callMsgId);
        } catch (err) {
          logger.error(
            { ...formatAxiosError(err), accountId, phone },
            'Failed to record call in Chatwoot'
          );
        }
      }
    }
  });
}

// ── 定时健康检查 ──────────────────────────────────────────────

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startHealthChecks(intervalMs = 60_000): void {
  if (healthCheckInterval) return;
  healthCheckInterval = setInterval(async () => {
    for (const rt of accounts.values()) {
      if (rt.status !== 'connected' || !rt.socket) continue;

      try {
        // 检测 socket 是否还有效（user 字段存在说明认证有效）
        const user = rt.socket.user;
        if (!user) {
          logger.warn({ accountId: rt.config.id }, 'Health check: user is null, session may be invalid');
          rt.status = 'disconnected';
          rt.updatedAt = new Date();
          broadcast();
          // 尝试重连
          scheduleReconnect(rt, 5000);
        } else {
          rt.lastHealthCheck = new Date();
          rt.updatedAt = new Date();
        }
      } catch (err) {
        logger.error({ err, accountId: rt.config.id }, 'Health check failed');
        rt.status = 'disconnected';
        rt.updatedAt = new Date();
        broadcast();
      }
    }
    broadcast(); // 更新 lastHealthCheck 时间
  }, intervalMs);
  logger.info({ intervalMs }, 'Health checks started');
}

export function stopHealthChecks(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

// ── 初始化（加载已保存的账号并自动连接） ──────────────────────

export async function initAccountManager(): Promise<void> {
  loadConversationMappings();
  const configs = loadAccountConfigs();
  for (const cfg of configs) {
    // 兼容旧配置（没有 chatwootInboxId 字段）
    if (cfg.chatwootInboxId === undefined) cfg.chatwootInboxId = null;
    const rt: AccountRuntime = {
      config: cfg,
      socket: null,
      status: hasSavedSession(cfg.id) ? 'disconnected' : 'logged_out',
      phone: null,
      qrDataUrl: null,
      qrRaw: null,
      updatedAt: new Date(),
      lastHealthCheck: null,
      processedMsgIds: new Set(),
      phoneToJid: new Map(),
      reconnectTimer: null,
      shuttingDown: false,
      connectionGeneration: 0,
    };
    accounts.set(cfg.id, rt);

    // 如果有 session 目录，尝试自动连接
    const sessionDir = getSessionDir(cfg.id);
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0) {
      logger.info({ accountId: cfg.id, label: cfg.label }, 'Auto-connecting saved account');
      startConnection(rt).catch(err => {
        logger.error({ err, accountId: cfg.id }, 'Auto-connect failed');
      });
    }
  }

  startHealthChecks();
  logger.info({ count: configs.length }, 'Account manager initialized');
}

// ── 消息解析（从 whatsapp.ts 迁移） ──────────────────────────

interface ParsedMessage {
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'call_log';
  text?: string;
  media?: { buffer: Buffer; mimetype: string; filename: string };
}

function isDirectChatJid(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function getExtFromMime(mimetype: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'audio/ogg; codecs=opus': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'application/pdf': '.pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  };
  return map[mimetype] ?? '';
}

async function parseMessage(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>
): Promise<ParsedMessage | null> {
  const message = msg.message;
  if (!message) return null;

  const text = message.conversation ?? message.extendedTextMessage?.text;
  if (text) return { type: 'text', text };

  if (message.imageMessage) {
    const caption = message.imageMessage.caption ?? '';
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: logger.child({ module: 'media-dl' }) as never,
        reuploadRequest: sock.updateMediaMessage,
      }) as Buffer;
      const mimetype = message.imageMessage.mimetype ?? 'image/jpeg';
      return { type: 'image', text: caption || '[图片]', media: { buffer, mimetype, filename: `image_${Date.now()}${getExtFromMime(mimetype)}` } };
    } catch { return { type: 'image', text: caption || '[图片 - 下载失败]' }; }
  }

  if (message.videoMessage) {
    const caption = message.videoMessage.caption ?? '';
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: logger.child({ module: 'media-dl' }) as never,
        reuploadRequest: sock.updateMediaMessage,
      }) as Buffer;
      const mimetype = message.videoMessage.mimetype ?? 'video/mp4';
      return { type: 'video', text: caption || '[视频]', media: { buffer, mimetype, filename: `video_${Date.now()}${getExtFromMime(mimetype)}` } };
    } catch { return { type: 'video', text: caption || '[视频 - 下载失败]' }; }
  }

  if (message.audioMessage) {
    const ptt = message.audioMessage.ptt;
    const label = ptt ? '[语音消息]' : '[音频文件]';
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: logger.child({ module: 'media-dl' }) as never,
        reuploadRequest: sock.updateMediaMessage,
      }) as Buffer;
      const mimetype = message.audioMessage.mimetype ?? 'audio/ogg; codecs=opus';
      return { type: 'audio', text: label, media: { buffer, mimetype, filename: `audio_${Date.now()}${getExtFromMime(mimetype)}` } };
    } catch { return { type: 'audio', text: `${label} - 下载失败` }; }
  }

  if (message.documentMessage) {
    const originalName = message.documentMessage.fileName ?? 'document';
    const caption = message.documentMessage.caption ?? '';
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: logger.child({ module: 'media-dl' }) as never,
        reuploadRequest: sock.updateMediaMessage,
      }) as Buffer;
      const mimetype = message.documentMessage.mimetype ?? 'application/octet-stream';
      return { type: 'document', text: caption || `[文件] ${originalName}`, media: { buffer, mimetype, filename: originalName } };
    } catch { return { type: 'document', text: `[文件] ${originalName} - 下载失败` }; }
  }

  if (message.stickerMessage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: logger.child({ module: 'media-dl' }) as never,
        reuploadRequest: sock.updateMediaMessage,
      }) as Buffer;
      const mimetype = message.stickerMessage.mimetype ?? 'image/webp';
      return { type: 'sticker', text: '[贴纸]', media: { buffer, mimetype, filename: `sticker_${Date.now()}${getExtFromMime(mimetype)}` } };
    } catch { return { type: 'sticker', text: '[贴纸]' }; }
  }

  if (message.bcallMessage) {
    const bcall = message.bcallMessage as Record<string, unknown>;
    const callType = bcall.videoCall ? '📹 视频通话' : '📞 语音通话';
    return { type: 'call_log', text: `[${callType}]` };
  }

  if (message.protocolMessage || message.senderKeyDistributionMessage) return null;

  const contentType = getContentType(message);
  if (contentType) {
    logger.debug({ contentType }, 'Unhandled message content type');
    return { type: 'text', text: `[未支持的消息类型: ${contentType}]` };
  }

  return null;
}

// ── 转发消息到 Chatwoot ───────────────────────────────────────

async function forwardToChatwoot(
  accountId: string,
  phone: string,
  displayName: string,
  parsed: ParsedMessage,
  providerMessageId: string,
  isFromMe: boolean,
  inboxId: number
): Promise<void> {
  const route: ConversationRoute = {
    accountId,
    inboxId,
    peerId: phone,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const contactId = await findOrCreateContact(phone, displayName, inboxId);
    const conversationId = await findOrCreateConversation(contactId, phone, inboxId, route);

    try {
      if (parsed.media) {
        await createMessageWithAttachment(
          conversationId, parsed.text ?? '', providerMessageId,
          parsed.media.buffer, parsed.media.filename, parsed.media.mimetype,
          isFromMe ? 'outgoing' : 'incoming'
        );
      } else if (isFromMe) {
        await createOutboundMessage(conversationId, parsed.text ?? '', providerMessageId);
      } else {
        await createInboundMessage(conversationId, parsed.text ?? '', providerMessageId);
      }

      logger.debug(
        { accountId, phone, contactId, conversationId, fromMe: isFromMe, type: parsed.type },
        'Message forwarded to Chatwoot'
      );
      return;
    } catch (err) {
      if (attempt === 1 && isConversationMissingError(err)) {
        logger.warn(
          { accountId, phone, conversationId },
          'Mapped Chatwoot conversation is missing, invalidating route and recreating'
        );
        invalidateConversationRoute(route);
        continue;
      }
      throw err;
    }
  }
}
