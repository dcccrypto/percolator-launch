/**
 * api-proxy.ts
 *
 * Shared utility for proxying Next.js API routes to percolator-api (Railway).
 * Eliminates duplicate Supabase query logic in percolator-launch.
 *
 * Usage:
 *   return proxyToApi(req, "/markets");
 *   return proxyToApi(req, `/markets/${slab}/trades`);
 *   return proxyToApi(req, "/bugs", { "x-api-key": key });
 *   return proxyToApi(req, "/bugs", { "x-real-ip": ip }, { includeBody: true });
 */

import { type NextRequest, NextResponse } from "next/server";
import { getBackendUrl } from "@/lib/config";

const PROXY_TIMEOUT_MS = 8_000;

export interface ProxyOptions {
  /**
   * When true, the raw request body is forwarded to the upstream.
   * Useful for POST/PUT/PATCH proxy routes.
   * Ignored for GET and HEAD requests.
   */
  includeBody?: boolean;
  /**
   * Override the upstream Cache-Control header instead of using the backend's value.
   * When omitted, the upstream Cache-Control is forwarded (or "no-store" as default).
   */
  cacheControl?: string;
  /**
   * Replace the forwarded query string (e.g. after validating `limit`).
   * Empty string means no query segment. When omitted, the request URL search is used.
   */
  queryString?: string;
}

/**
 * Proxy a Next.js route handler request to the percolator-api backend.
 *
 * @param req          The incoming NextRequest (query params are forwarded automatically).
 * @param apiPath      The backend path to call (e.g. "/markets", "/funding/global").
 * @param extraHeaders Optional headers to forward to the backend (e.g. x-api-key, x-real-ip).
 * @param options      Optional proxy behaviour overrides.
 */
export async function proxyToApi(
  req: NextRequest,
  apiPath: string,
  extraHeaders?: Record<string, string>,
  options?: ProxyOptions
): Promise<NextResponse> {
  let backendUrl: string;
  try {
    backendUrl = getBackendUrl();
  } catch {
    return NextResponse.json(
      { error: "Backend URL not configured" },
      { status: 502 }
    );
  }

  const forwardQs =
    options?.queryString !== undefined
      ? options.queryString
      : req.nextUrl.searchParams.toString();
  const targetUrl = forwardQs
    ? `${backendUrl}${apiPath}?${forwardQs}`
    : `${backendUrl}${apiPath}`;

  // Optionally read and forward the request body for mutation methods
  let requestBody: string | undefined;
  if (
    options?.includeBody &&
    req.method !== "GET" &&
    req.method !== "HEAD"
  ) {
    requestBody = await req.text();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: requestBody,
      signal: controller.signal,
    });

    const body = await upstream.text();

    const upstreamCacheControl =
      upstream.headers.get("Cache-Control") ?? "no-store, max-age=0";

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "application/json",
        "Cache-Control": options?.cacheControl ?? upstreamCacheControl,
      },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return NextResponse.json({ error: "Backend timeout" }, { status: 504 });
    }
    return NextResponse.json({ error: "Backend unavailable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
