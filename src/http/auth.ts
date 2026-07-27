/**
 * Runtime tenant identity.
 *
 * The tenant is never taken from a URL, a query string or a request body — it
 * is resolved from a credential (an `x-api-key` header for machine callers, an
 * HttpOnly cookie for the operator UI) against a registry supplied in the
 * environment. Every downstream read and write is scoped to whatever this
 * returns, so an unauthenticated request has no tenant and therefore no reach.
 */

import { timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'hm_session';

/**
 * Parses `TENANT_API_KEYS`, formatted as `key:tenantId,key:tenantId`.
 * Keys live in the environment only — never in code or in the database.
 */
export function loadTenantKeys(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const raw = env.TENANT_API_KEYS ?? '';
  const map = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.lastIndexOf(':');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const tenantId = trimmed.slice(separator + 1).trim();
    if (key && tenantId) map.set(key, tenantId);
  }
  return map;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Resolves a tenant id for a presented key, comparing in constant time. */
export function tenantForKey(
  presented: string | undefined,
  keys: Map<string, string>,
): string | null {
  if (!presented || presented.trim() === '') return null;
  for (const [key, tenantId] of keys) {
    if (constantTimeEquals(presented, key)) return tenantId;
  }
  return null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function sessionCookie(value: string, maxAgeSeconds = 43_200): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
