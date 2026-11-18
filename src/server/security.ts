// A localhost server that writes files must not be drivable by other web
// pages. Every request must name this server in Host (defeats DNS
// rebinding), cross-site requests are refused by Origin and Sec-Fetch-Site,
// and API and media requests need the per-run token, which the launch URL
// sets as a SameSite=Strict cookie.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface SecurityContext {
  port: number;
  token: string;
}

export type SecurityResult = { ok: true } | { ok: false; status: number; code: string; message: string };

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

export function cookieName(port: number): string {
  // Cookies are shared across ports on one host, so the name carries the port.
  return `cutline_${port}`;
}

export function allowedHosts(port: number): string[] {
  return LOOPBACK_HOSTS.map((host) => `${host}:${port}`);
}

export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host !== undefined && allowedHosts(port).includes(host.toLowerCase());
}

/** A missing Origin is fine (navigations, same-origin GETs, scripts); a present one must be ours. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || allowedOrigins(port).includes(origin.toLowerCase());
}

/** Sec-Fetch-Site is sent by browsers; "none" is a typed URL or bookmark. */
export function fetchSiteAllowed(site: string | undefined): boolean {
  return site === undefined || site === "same-origin" || site === "none";
}

export function tokensEqual(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) {
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        cookies.set(name, value);
      }
    }
  }
  return cookies;
}

export function requestToken(req: IncomingMessage, port: number): string | undefined {
  const header = req.headers["x-cutline-token"];
  if (typeof header === "string") return header;
  return parseCookies(req.headers.cookie).get(cookieName(port));
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Host, Origin and Sec-Fetch-Site checks that apply to every request. */
export function checkRequestOrigin(req: IncomingMessage, ctx: SecurityContext): SecurityResult {
  if (!hostAllowed(single(req.headers.host), ctx.port)) {
    return { ok: false, status: 421, code: "bad-host", message: "requests must be addressed to 127.0.0.1 or localhost" };
  }
  if (!originAllowed(single(req.headers.origin), ctx.port)) {
    return { ok: false, status: 403, code: "bad-origin", message: "cross-origin requests are not allowed" };
  }
  if (!fetchSiteAllowed(single(req.headers["sec-fetch-site"]))) {
    return { ok: false, status: 403, code: "cross-site", message: "cross-site requests are not allowed" };
  }
  return { ok: true };
}

export function checkToken(req: IncomingMessage, ctx: SecurityContext): SecurityResult {
  if (!tokensEqual(requestToken(req, ctx.port), ctx.token)) {
    return {
      ok: false,
      status: 401,
      code: "no-session",
      message: "open Cutline with the launch link printed by the cutline command",
    };
  }
  return { ok: true };
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}
