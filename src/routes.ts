import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { sendMessage, getAllAccounts } from './accountManager';
import { logger } from './logger';

const router = Router();

// ── 发送 WhatsApp 消息（供 AI Middleware / Chatwoot 调用）─────
// POST /api/v1/whatsapp/messages/send
const sendSchema = z.object({
  to: z.string().min(5),
  message: z.object({
    type: z.enum(['text']),
    text: z.string().min(1),
  }),
  account_id: z.string().optional(), // 可选：指定账号发送
  idempotency_key: z.string().optional(),
});

router.post('/api/v1/whatsapp/messages/send', async (req: Request, res: Response): Promise<void> => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 1004, message: 'invalid request', data: null });
    return;
  }

  const { to, message } = parsed.data;

  // 找到要用的账号：优先指定的，否则用第一个已连接的
  let accountId = parsed.data.account_id;
  if (!accountId) {
    const connected = getAllAccounts().find(a => a.status === 'connected');
    accountId = connected?.id;
  }

  if (!accountId) {
    res.status(503).json({ code: 2001, message: 'No connected WhatsApp account', data: null });
    return;
  }

  try {
    const providerMessageId = await sendMessage(accountId, to, message.text);
    res.json({
      code: 0,
      message: 'queued',
      data: { provider_message_id: providerMessageId, account_id: accountId },
    });
  } catch (err) {
    logger.error({ err, to, accountId }, 'Failed to send WhatsApp message');
    const errMsg = (err as Error).message ?? '';

    if (errMsg.includes('not connected')) {
      res.status(503).json({ code: 2001, message: 'WhatsApp session expired', data: null });
    } else {
      res.status(500).json({ code: 2004, message: 'send failed', data: null });
    }
  }
});

export default router;
