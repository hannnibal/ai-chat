/**
 * WhatsApp Session Manager
 *
 * 集中管理 WhatsApp 连接状态和 QR 码，供 HTTP API 和 Web 管理页面使用。
 */

import QRCode from 'qrcode';
import { logger } from './logger';

export type SessionStatus =
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'logged_out';

interface SessionState {
  status: SessionStatus;
  qrDataUrl: string | null;   // base64 PNG data URL
  qrRaw: string | null;       // 原始 QR 字符串
  phone: string | null;       // 登录的手机号
  updatedAt: Date;
}

const state: SessionState = {
  status: 'disconnected',
  qrDataUrl: null,
  qrRaw: null,
  phone: null,
  updatedAt: new Date(),
};

// SSE 客户端列表
const sseClients = new Set<(data: string) => void>();

function broadcast(): void {
  const payload = JSON.stringify(getState());
  for (const send of sseClients) {
    try { send(payload); } catch { /* client gone */ }
  }
}

export function setStatus(status: SessionStatus): void {
  state.status = status;
  state.updatedAt = new Date();
  if (status === 'connected' || status === 'logged_out' || status === 'disconnected') {
    state.qrDataUrl = null;
    state.qrRaw = null;
  }
  broadcast();
  logger.info({ status }, 'Session status changed');
}

export async function setQR(qrString: string): Promise<void> {
  state.status = 'qr_required';
  state.qrRaw = qrString;
  state.qrDataUrl = await QRCode.toDataURL(qrString, { width: 300, margin: 2 });
  state.updatedAt = new Date();
  broadcast();
}

export function setPhone(phone: string): void {
  state.phone = phone;
}

export function clearQR(): void {
  state.qrDataUrl = null;
  state.qrRaw = null;
}

export function getState(): Readonly<Omit<SessionState, 'qrRaw'>> & { qrRaw?: string } {
  return {
    status: state.status,
    qrDataUrl: state.qrDataUrl,
    phone: state.phone,
    updatedAt: state.updatedAt,
  };
}

export function getQRRaw(): string | null {
  return state.qrRaw;
}

export function subscribeSse(send: (data: string) => void): () => void {
  sseClients.add(send);
  return () => sseClients.delete(send);
}
