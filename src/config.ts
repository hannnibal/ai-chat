import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, def: string): string {
  return process.env[key] ?? def;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  chatwoot: {
    baseUrl: required('CHATWOOT_BASE_URL'),
    apiToken: required('CHATWOOT_API_TOKEN'),
    accountId: parseInt(required('CHATWOOT_ACCOUNT_ID'), 10),
  },

  aiMiddleware: {
    url: optional('AI_MIDDLEWARE_URL', 'http://localhost:3000'),
    token: optional('AI_MIDDLEWARE_TOKEN', ''),
  },

  wa: {
    sessionDir: optional('WA_SESSION_DIR', './wa_session'),
  },
} as const;
