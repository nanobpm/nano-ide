// A minimal path router shared by the surfaces and triggers modules so the runtime serves
// a single HTTP port. Matching is exact path or, for a route registered with `prefix`,
// a path-prefix match. First match wins.

import type { HttpHandler, HttpRequest, HttpResponse } from "./host.ts";

/**
 * A route handler that may DECLINE a matched request by returning `undefined`
 * (or a promise of it). The router then treats the route as if it had not matched
 * and continues to the next route (fall-through). This lets a broad prefix route —
 * e.g. the pages surface's nested static serve at `/` — claim only the requests it
 * can actually satisfy (a real, safe asset) and let everything else (`/healthz`, an
 * app's own trigger routes registered *after* it) resolve to their own handlers,
 * instead of a root catch-all silently swallowing them. A handler that returns a
 * concrete `HttpResponse` (including a 404) still short-circuits as before, so this
 * is backwards-compatible with every existing handler (none return `undefined`).
 */
export type RouteHandler = (req: HttpRequest) => Promise<HttpResponse | undefined> | HttpResponse | undefined;

export interface Route {
  method: string;
  path: string;
  /** When true, match any path that starts with `path`. */
  prefix?: boolean;
  handler: RouteHandler;
  /** For diagnostics / inspect(). */
  source?: string;
}

export function json(body: unknown, status = 200): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function html(body: string, status = 200): HttpResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

export function text(body: string, status = 200): HttpResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

/**
 * A `204 No Content` response: an empty body and no `content-type`. Use this
 * instead of `json(null, 204)` — the latter emits a `"null"` body that both
 * violates the no-body semantics of 204 and makes a client that parses the
 * body throw. Any client that short-circuits 204 receives no payload here.
 */
export function noContent(): HttpResponse {
  return { status: 204, headers: {}, body: "" };
}

/**
 * Normalize a manifest-supplied route path: collapse leading slashes to exactly
 * one, drop trailing slashes. Incoming request paths always start with "/", so a
 * manifest path lacking one (e.g. "hooks/x") would otherwise never match. Collapsing
 * multiple leading slashes also hardens derived URLs (e.g. the Swagger `servers`
 * entry or the pages "API docs" badge): a `//host` value stays an in-app absolute
 * path instead of becoming a protocol-relative URL that navigates off-origin. Falls
 * back to `fallback` when the value is missing or collapses to empty ("/").
 */
export function normalizeRoutePath(value: string | undefined, fallback: string): string {
  const raw = (value ?? fallback).trim();
  const withLead = `/${raw.replace(/^\/+/, "")}`;
  const noTrail = withLead.replace(/\/+$/, "");
  return noTrail || fallback;
}

function matches(route: Route, req: HttpRequest): boolean {
  if (route.method !== "*" && route.method.toUpperCase() !== req.method.toUpperCase()) return false;
  return route.prefix ? req.path.startsWith(route.path) : req.path === route.path;
}

/** Build a single HttpHandler that dispatches across the given routes. */
export function makeRouter(routes: Route[]): HttpHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    for (const route of routes) {
      if (matches(route, req)) {
        // A handler may DECLINE by returning `undefined` (see RouteHandler): treat the
        // route as unmatched and keep looking, so a broad prefix serve can't shadow a
        // later exact route (`/healthz`, a trigger) it didn't actually satisfy.
        const res = await route.handler(req);
        if (res !== undefined) return res;
      }
    }
    return text("not found", 404);
  };
}
