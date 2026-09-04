// The security floor's HTTP half (spec/tools-and-security.md §Security floor).
import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { writeSecretFile, type SecretFileResult } from './secretFile.js';

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The token is a bearer credential: whoever reads this file has the whole API. It gets the same protection as
 * the credentials file, and reports whether it got it — the caller decides how loudly to say so.
 *
 * (The directory used to come from a hand-rolled dirname that split on `/` alone, which on Windows returned
 * "." for every absolute path and so created nothing.)
 */
export function writeTokenFile(file: string, token: string): SecretFileResult {
  return writeSecretFile(file, token);
}

export const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cache-Control', 'no-store');
  };
}

/** Accepted Host values: 127.0.0.1:<port>, localhost:<port>, [::1]:<port>, the bind address, and any --expose origin host. */
export function acceptedHosts(port: number, bind: string, exposed: string[]): Set<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${bind}:${port}`]);
  for (const origin of exposed) {
    try {
      const u = new URL(origin.includes('://') ? origin : `https://${origin}`);
      hosts.add(u.host);
    } catch {
      hosts.add(origin);
    }
  }
  return hosts;
}

/** Host and Origin are checked before the token (403 before 401). Requests without Origin (the CLI) pass the origin check. */
export function hostOriginGuard(hosts: () => Set<string>): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (!host || !hosts().has(host)) return c.json({ error: { code: 'forbidden', message: `Host "${host ?? ''}" is not an accepted address for this runtime.` } }, 403);
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      if (origin === 'null') return c.json({ error: { code: 'forbidden', message: 'Origin "null" is not accepted.' } }, 403);
      let ok = false;
      try {
        const u = new URL(origin);
        ok = (u.protocol === 'http:' || u.protocol === 'https:') && hosts().has(u.host);
      } catch {
        ok = false;
      }
      if (!ok) return c.json({ error: { code: 'forbidden', message: `Origin "${origin}" is not accepted.` } }, 403);
    }
    await next();
  };
}

export function bearerGuard(token: () => string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!presented || !timingSafeEqualStr(presented, token())) {
      return c.json({ error: { code: 'unauthorized', message: 'A runtime token is required. Open the URL printed by `workbench start`, or pass Authorization: Bearer <token>.' } }, 401);
    }
    await next();
  };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
