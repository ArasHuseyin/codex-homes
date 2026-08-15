import fs from 'node:fs';
import path from 'node:path';

/**
 * Decode a JWT payload. Signature is NOT verified — this is display-only, the
 * token is never sent anywhere and Codex validates it server-side anyway.
 */
function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;

  let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padding = base64.length % 4;
  if (padding === 2) base64 += '==';
  else if (padding === 3) base64 += '=';
  else if (padding === 1) return null;

  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the account behind a CODEX_HOME directory.
 * Only non-secret fields are returned — tokens never leave this function.
 *
 * state: 'logged-out' | 'invalid' | 'apikey' | 'chatgpt' | 'unknown'
 */
export function readAccount(homeDir) {
  const result = {
    state: 'logged-out',
    email: null,
    plan: null,
    accountId: null,
    mode: null,
    expiresAt: null,
    lastRefresh: null,
  };

  const authPath = path.join(homeDir, 'auth.json');
  if (!fs.existsSync(authPath)) return result;

  let raw;
  try {
    // Strip a UTF-8 BOM: JSON.parse rejects it, and editors on Windows add one.
    raw = JSON.parse(fs.readFileSync(authPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    result.state = 'invalid';
    return result;
  }

  result.mode = typeof raw.auth_mode === 'string' ? raw.auth_mode : null;
  result.lastRefresh = typeof raw.last_refresh === 'string' ? raw.last_refresh : null;

  const idToken = raw?.tokens?.id_token;
  if (idToken) {
    const payload = decodeJwtPayload(idToken);
    if (payload) {
      result.state = 'chatgpt';
      result.email = payload.email ?? null;
      const claims = payload['https://api.openai.com/auth'] ?? {};
      result.plan = claims.chatgpt_plan_type ?? null;
      result.accountId = claims.chatgpt_account_id ?? raw.tokens.account_id ?? null;
      if (typeof payload.exp === 'number') {
        result.expiresAt = new Date(payload.exp * 1000);
      }
      return result;
    }
    result.state = 'unknown';
    return result;
  }

  if (typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.length > 0) {
    result.state = 'apikey';
  }
  return result;
}

/** Short human-readable label for the account behind a home directory. */
export function describeAccount(account) {
  switch (account.state) {
    case 'chatgpt':
      return account.email ?? 'ChatGPT account';
    case 'apikey':
      return 'API key';
    case 'invalid':
      return 'auth.json unreadable';
    case 'unknown':
      return 'token not decodable';
    default:
      return 'not logged in';
  }
}
