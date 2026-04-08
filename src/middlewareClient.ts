/**
 * AI Middleware Client
 * 向 AI Middleware 上报 WhatsApp 连接状态
 */

import axios from 'axios';
import { config } from './config';
import { logger } from './logger';

type SessionStatus = 'connected' | 'connecting' | 'disconnected' | 'qr_required' | 'error';

export async function reportSessionStatus(status: SessionStatus): Promise<void> {
  if (!config.aiMiddleware.url) return;

  try {
    await axios.post(
      `${config.aiMiddleware.url}/api/v1/webhooks/whatsapp/session/status`,
      {
        session_id: 'wa-main',
        status,
        timestamp: new Date().toISOString(),
      },
      {
        headers: { Authorization: `Bearer ${config.aiMiddleware.token}` },
        timeout: 5000,
      }
    );
  } catch (err) {
    // 状态上报失败不影响主流程
    logger.debug({ err, status }, 'Failed to report session status to middleware');
  }
}
