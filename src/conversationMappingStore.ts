import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './logger';

interface ConversationMappingRecord {
  accountId: string;
  inboxId: number;
  peerId: string;
  contactId: number;
  conversationId: number;
  updatedAt: string;
}

interface ConversationMappingFile {
  version: 1;
  records: ConversationMappingRecord[];
}

const DATA_DIR = path.resolve(config.wa.sessionDir, '..');
const STORE_FILE = path.join(DATA_DIR, 'conversation-mappings.json');

const mappingByRouteKey = new Map<string, ConversationMappingRecord>();

function routeKey(accountId: string, inboxId: number, peerId: string): string {
  return `${accountId}:${inboxId}:${peerId}`;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function persist(): void {
  ensureDataDir();
  const payload: ConversationMappingFile = {
    version: 1,
    records: Array.from(mappingByRouteKey.values()).sort((a, b) =>
      routeKey(a.accountId, a.inboxId, a.peerId).localeCompare(routeKey(b.accountId, b.inboxId, b.peerId))
    ),
  };
  const tmpFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpFile, STORE_FILE);
}

export function loadConversationMappings(): void {
  mappingByRouteKey.clear();
  if (!fs.existsSync(STORE_FILE)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as ConversationMappingFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.records)) {
      logger.warn({ storeFile: STORE_FILE }, 'Conversation mapping store has invalid format, ignoring');
      return;
    }

    for (const record of parsed.records) {
      if (
        !record
        || typeof record.accountId !== 'string'
        || typeof record.inboxId !== 'number'
        || typeof record.peerId !== 'string'
        || typeof record.contactId !== 'number'
        || typeof record.conversationId !== 'number'
      ) {
        continue;
      }
      mappingByRouteKey.set(routeKey(record.accountId, record.inboxId, record.peerId), record);
    }
  } catch (err) {
    logger.warn({ err, storeFile: STORE_FILE }, 'Failed to load conversation mappings, starting fresh');
  }
}

export function getConversationMapping(accountId: string, inboxId: number, peerId: string): ConversationMappingRecord | null {
  return mappingByRouteKey.get(routeKey(accountId, inboxId, peerId)) ?? null;
}

export function saveConversationMapping(record: Omit<ConversationMappingRecord, 'updatedAt'>): void {
  mappingByRouteKey.set(routeKey(record.accountId, record.inboxId, record.peerId), {
    ...record,
    updatedAt: new Date().toISOString(),
  });
  persist();
}

export function removeConversationMapping(accountId: string, inboxId: number, peerId: string): void {
  mappingByRouteKey.delete(routeKey(accountId, inboxId, peerId));
  persist();
}

export function removeConversationMappingsForAccount(accountId: string): void {
  let changed = false;
  for (const [key, record] of mappingByRouteKey.entries()) {
    if (record.accountId === accountId) {
      mappingByRouteKey.delete(key);
      changed = true;
    }
  }
  if (changed) persist();
}
