import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const CACHE_PATH = path.join(projectRoot, 'data', '.fs-token-cache.json');

function getEnvironment() {
  const env = (process.env.FS_ENVIRONMENT || 'sandbox').toLowerCase();
  if (env !== 'sandbox' && env !== 'production') {
    throw new Error(`FS_ENVIRONMENT must be sandbox|production (got ${process.env.FS_ENVIRONMENT || ''})`);
  }
  return env;
}

function getIdentityBaseUrl(environment) {
  // FamilySearch OAuth2 token endpoint is hosted on ident* domains.
  return environment === 'production'
    ? 'https://ident.familysearch.org'
    : 'https://identint.familysearch.org';
}

function readCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

function isTokenValid(cache) {
  if (!cache?.access_token || !cache?.expires_at) return false;
  const expiresAt = Date.parse(cache.expires_at);
  if (!Number.isFinite(expiresAt)) return false;
  // refresh a minute early
  return Date.now() < expiresAt - 60_000;
}

async function requestToken({ clientId, clientSecret, grantType, environment }) {
  const tokenUrl = `${getIdentityBaseUrl(environment)}/cis-web/oauth2/v3/token`;

  const body = new URLSearchParams();
  body.set('grant_type', grantType);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  // FamilySearch token requests support basic auth with client_id:client_secret.
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf-8').toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    // For unauthenticated_session, client_id is passed explicitly.
    body.set('client_id', clientId);
  }

  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FamilySearch token request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FamilySearch token response was not JSON: ${text.slice(0, 200)}`);
  }

  const accessToken = json.access_token;
  const expiresIn = Number(json.expires_in || 0);
  if (!accessToken) throw new Error('FamilySearch token response missing access_token');

  const expiresAt = new Date(Date.now() + Math.max(0, expiresIn) * 1000).toISOString();
  return {
    access_token: accessToken,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || null,
    expires_in: expiresIn,
    expires_at: expiresAt,
    obtained_at: new Date().toISOString(),
    grant_type: grantType,
    environment
  };
}

/**
 * Get a valid FamilySearch API access token.
 *
 * - Reads config from `.env` (never committed).
 * - Caches tokens to `data/.fs-token-cache.json` and refreshes automatically when expired.
 *
 * Note: FamilySearch "client_credentials" is restricted for general use. If unavailable,
 * this function will fall back to `unauthenticated_session` (limited access).
 */
export async function getAccessToken() {
  const clientId = process.env.FS_CLIENT_ID;
  const clientSecret = process.env.FS_CLIENT_SECRET || '';
  if (!clientId) {
    throw new Error('FS_CLIENT_ID is required (set it in .env; see .env.example)');
  }

  const environment = getEnvironment();

  const cached = readCache();
  if (isTokenValid(cached) && cached.environment === environment) {
    return cached.access_token;
  }

  // Try client credentials when a secret is provided, otherwise use unauthenticated_session.
  if (clientSecret) {
    try {
      const token = await requestToken({
        clientId,
        clientSecret,
        grantType: 'client_credentials',
        environment
      });
      writeCache(token);
      return token.access_token;
    } catch (err) {
      // Fall through to unauthenticated_session for read-only endpoints that allow it.
      const msg = err instanceof Error ? err.message : String(err);
      // Cache nothing; proceed.
      console.warn(`Warning: client_credentials token failed, trying unauthenticated_session. (${msg})`);
    }
  }

  const token = await requestToken({
    clientId,
    clientSecret: '',
    grantType: 'unauthenticated_session',
    environment
  });
  writeCache(token);
  return token.access_token;
}

