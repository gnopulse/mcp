/**
 * Client for the GnoPulse REST API. Tools use the v2 resource API (`/api/v2/*`,
 * `{data, meta, error}` envelope, cursor pagination); `get()` covers the few
 * legacy v1 routes without a v2 equivalent.
 */
import type { Config } from "./config.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A v2 response: the unwrapped payload plus the envelope's meta. */
export interface V2Result<T = any> {
  data: T;
  meta: Record<string, any>;
}

/** A v2 list response with pagination fields flattened for the agent. */
export interface V2Page<T = any> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
  stats?: unknown;
  by_collection?: unknown;
  total?: number;
}

type Params = Record<string, unknown>;

interface RawResponse {
  status: number;
  ok: boolean;
  body: string;
}

export class ApiClient {
  constructor(private readonly cfg: Config) {}

  /** GET /api/v2/<path> and unwrap the envelope. Throws ApiError on a v2 error. */
  async getV2<T = any>(path: string, params?: Params): Promise<V2Result<T>> {
    const clean = path.replace(/^\/+/, "");
    const { status, ok, body } = await this.request(this.url(`/api/v2/${clean}`, params));

    let parsed: any;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      throw new ApiError(`v2 ${clean}: non-JSON response (HTTP ${status}): ${body.slice(0, 200)}`, status);
    }
    const error = parsed?.error;
    if (error) {
      // Auth and rate-limit rejections carry a plain string rather than {code, message}.
      if (typeof error === "string") throw new ApiError(error, status);
      throw new ApiError(`${error.code ?? "error"}: ${error.message ?? "unknown"}`, status, error.code);
    }
    if (!ok) throw new ApiError(`v2 ${clean}: HTTP ${status}: ${body.slice(0, 200)}`, status);
    return { data: parsed?.data, meta: parsed?.meta ?? {} };
  }

  /** v2 list: rows plus `next_cursor` / `has_more` so the agent can page. */
  async listV2<T = any>(path: string, params?: Params): Promise<V2Page<T>> {
    const { data, meta } = await this.getV2<T[]>(path, params);
    return {
      items: data ?? [],
      next_cursor: meta.next_cursor ?? null,
      has_more: meta.has_more ?? false,
      ...(meta.stats ? { stats: meta.stats } : {}),
      ...(meta.by_collection ? { by_collection: meta.by_collection } : {}),
      ...(meta.total != null ? { total: meta.total } : {}),
    };
  }

  /** GET a legacy v1 route. Prefer getV2. */
  async get(path: string, params?: Params): Promise<any> {
    const { status, ok, body } = await this.request(this.url(path.startsWith("/") ? path : `/${path}`, params));
    if (!ok) throw new ApiError(`GET ${path}: HTTP ${status}: ${body.slice(0, 300)}`, status);
    return body ? JSON.parse(body) : null;
  }

  private url(path: string, params?: Params): URL {
    const url = new URL(this.cfg.apiBase + path);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async request(url: URL): Promise<RawResponse> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cfg.apiKey) headers["X-API-Key"] = this.cfg.apiKey;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    return { status: resp.status, ok: resp.ok, body: await resp.text() };
  }
}
