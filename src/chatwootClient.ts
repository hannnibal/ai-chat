/**
 * Chatwoot API Client
 *
 * 负责将 WhatsApp 消息桥接到 Chatwoot：
 *  1. 查找或创建联系人
 *  2. 查找或创建会话
 *  3. 在会话中写入消息
 *
 * 使用 Chatwoot 的管理 API（需要 api_access_token）
 */

import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { config } from './config';
import { logger } from './logger';
import {
  getConversationMapping,
  saveConversationMapping,
  removeConversationMapping,
} from './conversationMappingStore';

const http: AxiosInstance = axios.create({
  baseURL: `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}`,
  headers: {
    api_access_token: config.chatwoot.apiToken,
    'Content-Type': 'application/json',
  },
  timeout: 10_000,
});

export interface ConversationRoute {
  accountId: string;
  inboxId: number;
  peerId: string;
}

/** 从 Axios 错误中提取关键信息，避免打印整个对象 */
export function formatAxiosError(err: unknown): Record<string, unknown> {
  if (axios.isAxiosError(err)) {
    return {
      code: err.code,
      message: err.message,
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      url: err.config?.url,
      method: err.config?.method,
    };
  }
  return { message: (err as Error).message };
}

/** 从 Chatwoot 响应中安全提取 contact id（兼容不同返回格式） */
function extractContactId(data: Record<string, unknown>): number | undefined {
  // 格式1: { id: 123, ... }
  if (typeof data?.id === 'number') return data.id;
  // 格式2: { payload: { contact: { id: 123 } } }
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (typeof payload?.id === 'number') return payload.id;
  const contact = payload?.contact as Record<string, unknown> | undefined;
  if (typeof contact?.id === 'number') return contact.id;
  return undefined;
}

/** 从 Chatwoot 响应中安全提取 conversation id（兼容不同返回格式） */
function extractConversationId(data: Record<string, unknown>): number | undefined {
  if (typeof data?.id === 'number') return data.id;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (typeof payload?.id === 'number') return payload.id;
  const conversation = payload?.conversation as Record<string, unknown> | undefined;
  if (typeof conversation?.id === 'number') return conversation.id;
  return undefined;
}

function normalizePeerId(peerId: string): string {
  return peerId.replace(/^\+/, '').trim();
}

function extractMessageId(data: Record<string, unknown>): number | undefined {
  if (typeof data?.id === 'number') return data.id;
  const payload = data?.payload as Record<string, unknown> | undefined;
  if (typeof payload?.id === 'number') return payload.id;
  const message = payload?.message as Record<string, unknown> | undefined;
  if (typeof message?.id === 'number') return message.id;
  return undefined;
}

// ── 查找或创建联系人 ──────────────────────────────────────────
export async function findOrCreateContact(
  phone: string,
  displayName: string,
  inboxId: number
): Promise<number> {
  // 先搜索
  const search = await http.get('/contacts/search', {
    params: { q: phone, include_contacts: true },
  });

  const existing = search.data?.payload?.find(
    (c: { phone_number?: string }) => c.phone_number === `+${phone.replace(/^\+/, '')}`
  );
  if (existing) return existing.id;

  // 不存在则创建
  try {
    const created = await http.post('/contacts', {
      name: displayName || phone,
      phone_number: `+${phone.replace(/^\+/, '')}`,
      inbox_id: inboxId,
    });

    const contactId = extractContactId(created.data);
    if (!contactId) {
      logger.error({ phone, responseData: JSON.stringify(created.data).slice(0, 300) }, 'Chatwoot contact creation returned unexpected format');
      throw new Error(`Failed to extract contact ID for phone ${phone}`);
    }
    logger.debug({ contactId, phone }, 'Created Chatwoot contact');
    return contactId;
  } catch (err: unknown) {
    // 422 = 联系人已存在（并发创建的竞态条件），重新搜索
    if (axios.isAxiosError(err) && err.response?.status === 422) {
      logger.debug({ phone }, 'Contact already exists (422), re-searching');
      const retry = await http.get('/contacts/search', {
        params: { q: phone, include_contacts: true },
      });
      const found = retry.data?.payload?.find(
        (c: { phone_number?: string }) => c.phone_number === `+${phone.replace(/^\+/, '')}`
      );
      if (found) return found.id;
    }
    throw err;
  }
}

// ── 查找或创建会话 ────────────────────────────────────────────
export async function findOrCreateConversation(
  contactId: number,
  sourceId: string,
  inboxId: number,
  route?: ConversationRoute
): Promise<number> {
  if (!contactId || !Number.isFinite(contactId)) {
    throw new Error(`Invalid contactId: ${contactId}`);
  }
  const normalizedPeerId = route ? normalizePeerId(route.peerId) : normalizePeerId(sourceId);

  if (route) {
    const mapping = getConversationMapping(route.accountId, route.inboxId, normalizedPeerId);
    if (mapping?.conversationId) {
      return mapping.conversationId;
    }
  }

  // 按 inbox_id 查找已有会话（每个 WhatsApp 账号独立的 inbox）
  try {
    const convs = await http.get(`/contacts/${contactId}/conversations`);
    const existing = convs.data?.payload?.find(
      (c: { inbox_id: number }) => c.inbox_id === inboxId
    );
    if (existing?.id) {
      if (route) {
        saveConversationMapping({
          accountId: route.accountId,
          inboxId: route.inboxId,
          peerId: normalizedPeerId,
          contactId,
          conversationId: existing.id,
        });
      }
      return existing.id;
    }
  } catch (err) {
    logger.warn(
      { ...formatAxiosError(err), contactId, inboxId },
      'Failed to list Chatwoot conversations for contact, falling back to create'
    );
  }

  const created = await http.post('/conversations', {
    inbox_id: inboxId,
    contact_id: contactId,
    additional_attributes: { source_id: sourceId },
  });

  const conversationId = extractConversationId(created.data);
  if (!conversationId) {
    logger.error(
      { contactId, sourceId, responseData: JSON.stringify(created.data).slice(0, 300) },
      'Chatwoot conversation creation returned unexpected format'
    );
    throw new Error(`Failed to extract conversation ID for contact ${contactId}`);
  }

  if (route) {
    saveConversationMapping({
      accountId: route.accountId,
      inboxId: route.inboxId,
      peerId: normalizedPeerId,
      contactId,
      conversationId,
    });
  }
  logger.debug({ conversationId, contactId }, 'Created Chatwoot conversation');
  return conversationId;
}

export function invalidateConversationRoute(route: ConversationRoute): void {
  removeConversationMapping(route.accountId, route.inboxId, normalizePeerId(route.peerId));
}

function isConversationMissingError(err: unknown): boolean {
  return axios.isAxiosError(err) && err.response?.status === 404;
}

async function createMessage(
  conversationId: number,
  body: Record<string, unknown>,
  logLabel: string
): Promise<number> {
  const res = await http.post(`/conversations/${conversationId}/messages`, body);
  const messageId = extractMessageId(res.data);
  if (!messageId) {
    logger.error(
      { conversationId, responseData: JSON.stringify(res.data).slice(0, 300) },
      `Chatwoot ${logLabel} returned unexpected format`
    );
    throw new Error(`Failed to extract message ID for conversation ${conversationId}`);
  }

  logger.debug({ conversationId, chatwootMessageId: messageId }, `${logLabel} created in Chatwoot`);
  return messageId;
}

// ── 写入入站消息（客户发来的）────────────────────────────────
export async function createInboundMessage(
  conversationId: number,
  content: string,
  providerMessageId: string
): Promise<number> {
  return createMessage(conversationId, {
    content,
    message_type: 'incoming',
    private: false,
    content_attributes: { provider_message_id: providerMessageId },
  }, 'Inbound message');
}

// ── 写入出站消息（自己发出的）─────────────────────────────────
export async function createOutboundMessage(
  conversationId: number,
  content: string,
  providerMessageId: string
): Promise<number> {
  return createMessage(conversationId, {
    content,
    message_type: 'outgoing',
    private: false,
    content_attributes: { provider_message_id: providerMessageId },
  }, 'Outbound message');
}

// ── 写入带附件的消息（图片/视频/音频/文档）────────────────────
export async function createMessageWithAttachment(
  conversationId: number,
  content: string,
  providerMessageId: string,
  fileBuffer: Buffer,
  filename: string,
  mimetype: string,
  messageType: 'incoming' | 'outgoing' = 'incoming'
): Promise<number> {
  const form = new FormData();
  form.append('content', content);
  form.append('message_type', messageType);
  form.append('private', 'false');
  form.append('content_attributes', JSON.stringify({ provider_message_id: providerMessageId }));
  form.append('attachments[]', fileBuffer, { filename, contentType: mimetype });

  const res = await axios.post(
    `${config.chatwoot.baseUrl}/api/v1/accounts/${config.chatwoot.accountId}/conversations/${conversationId}/messages`,
    form,
    {
      headers: {
        api_access_token: config.chatwoot.apiToken,
        ...form.getHeaders(),
      },
      timeout: 30_000, // 媒体上传可能较慢
    }
  );

  const messageId = extractMessageId(res.data);
  if (!messageId) {
    logger.error(
      { conversationId, filename, mimetype, responseData: JSON.stringify(res.data).slice(0, 300) },
      'Chatwoot attachment message returned unexpected format'
    );
    throw new Error(`Failed to extract attachment message ID for conversation ${conversationId}`);
  }

  logger.debug(
    { conversationId, chatwootMessageId: messageId, filename, mimetype },
    'Message with attachment created in Chatwoot'
  );
  return messageId;
}

// ── 获取会话最新消息（用于检查重复）─────────────────────────
export async function getRecentMessageIds(conversationId: number): Promise<Set<string>> {
  try {
    const res = await http.get(`/conversations/${conversationId}/messages`);
    const msgs: Array<{ content_attributes?: { provider_message_id?: string } }> =
      res.data?.payload ?? [];
    const ids = new Set<string>();
    for (const m of msgs) {
      const pid = m.content_attributes?.provider_message_id;
      if (pid) ids.add(pid);
    }
    return ids;
  } catch {
    return new Set();
  }
}

export { isConversationMissingError };
