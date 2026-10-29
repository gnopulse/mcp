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
  limit?: number;
  offset?: number;
  next_offset?: number | null;
  quota?: Record<string, string>;
}

type Params = Record<string, unknown>;

interface RawResponse {
  status: number;
  ok: boolean;
  body: string;
  quota: Record<string, string>;
}

/** How long a tool waits for a result the API is still computing, e.g. a cold wallet's balances. */
const PENDING_BUDGET_MS = 25_000;

/** True when the API answered before the result was ready. Pending answers are not billed. */
function isPending(data: unknown, meta: Record<string, any>): boolean {
  return meta.pending === true || (typeof data === "object" && data !== null && (data as any).pending === true);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class ApiClient {
  constructor(
    private readonly cfg: Config,
    private readonly pendingBudgetMs = PENDING_BUDGET_MS,
  ) {}

  /**
   * GET /api/v2/<path> and unwrap the envelope. Throws ApiError on a v2 error.
   *
   * A pending answer carries placeholder data (an empty token list, say), so it is never returned
   * as the result: wait for the advertised retry and ask again, and fail if it is still pending.
   */
  async getV2<T = any>(path: string, params?: Params): Promise<V2Result<T>> {
    const deadline = Date.now() + this.pendingBudgetMs;
    for (;;) {
      const result = await this.fetchV2<T>(path, params);
      if (!isPending(result.data, result.meta)) return result;
      const wait = Math.min(5, Math.max(1, Number(result.meta.retry_after) || 2)) * 1000;
      if (Date.now() + wait > deadline) {
        throw new ApiError(`pending: the API is still computing ${path.replace(/^\/+/, "")}; ask again in a few seconds`, 202, "pending");
      }
      await sleep(wait);
    }
  }

  private async fetchV2<T = any>(path: string, params?: Params): Promise<V2Result<T>> {
    const clean = path.replace(/^\/+/, "");
    const { status, ok, body, quota } = await this.request(this.url(`/api/v2/${clean}`, params));

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
    const nested = parsed?.data?.error;
    if (nested) throw new ApiError(typeof nested === "string" ? nested : JSON.stringify(nested), status);
    return { data: parsed?.data, meta: { ...parsed?.meta, quota } };
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
      ...(meta.market_as_of !== undefined ? { market_as_of: meta.market_as_of } : {}),
      ...(meta.ignored_params ? { ignored_params: meta.ignored_params } : {}),
      ...(meta.total != null ? { total: meta.total } : {}),
      ...(meta.limit != null ? { limit: meta.limit } : {}),
      ...(meta.offset != null ? { offset: meta.offset,
        next_offset: meta.has_more ? meta.offset + (data?.length ?? 0) : null } : {}),
      quota: meta.quota,
    };
  }

  /** Reject old APIs that ignore NFT cursors instead of repeating page one silently. */
  async nftPageV2(path: string, params?: Params): Promise<V2Page> {
    const { data, meta } = await this.getV2<unknown[]>(path, params);
    if (!Array.isArray(data) || typeof meta.has_more !== "boolean" ||
        !Object.prototype.hasOwnProperty.call(meta, "next_cursor") ||
        (meta.next_cursor !== null && (typeof meta.next_cursor !== "string" || !meta.next_cursor)) ||
        meta.has_more !== (meta.next_cursor !== null) ||
        (meta.has_more && data.length === 0) ||
        (params?.cursor && meta.next_cursor === params.cursor)) {
      throw new ApiError("NFT API pagination is unsupported or contradictory. Use an API release with NFT cursor support.");
    }
    return { items: data, next_cursor: meta.next_cursor, has_more: meta.has_more,
      total: meta.total, limit: meta.limit, by_collection: meta.by_collection, quota: meta.quota };
  }

  /** Holder distribution is a bundle, not an array-valued resource page. */
  async holderPageV2(path: string, params?: Params) {
    const { data, meta } = await this.getV2<Record<string, any>>(path, params);
    const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
    const nextOffset = data?.offset + (data?.holders?.length ?? 0);
    if (
      !data ||
      !Array.isArray(data.holders) ||
      !integer(data.holder_count) ||
      !integer(data.offset) ||
      !integer(data.limit) ||
      data.limit < 1 ||
      data.holders.length > data.limit ||
      !integer(nextOffset) ||
      (data.holders.length > 0 && nextOffset > data.holder_count) ||
      data.offset !== Number(params?.offset ?? 0) ||
      (params?.limit !== undefined && data.limit !== Number(params.limit)) ||
      typeof data.has_more !== "boolean" ||
      data.has_more !== nextOffset < data.holder_count ||
      (data.has_more && data.holders.length === 0)
    ) {
      throw new ApiError("Holder response has invalid or contradictory pagination.");
    }
    return {
      // Preserve the published distribution bundle and every summary/partiality field.
      items: data,
      next_cursor: null,
      has_more: data.has_more,
      total: data.holder_count,
      limit: data.limit,
      offset: data.offset,
      next_offset: data.has_more ? nextOffset : null,
      quota: meta.quota
    };
  }

  /** GET a legacy v1 route. Prefer getV2. */
  async get(path: string, params?: Params): Promise<any> {
    const { status, ok, body, quota } = await this.request(this.url(path.startsWith("/") ? path : `/${path}`, params));
    if (!ok) throw new ApiError(`GET ${path}: HTTP ${status}: ${body.slice(0, 300)}`, status);
    const parsed = body ? JSON.parse(body) : null;
    if (parsed?.error) throw new ApiError(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error), status);
    return parsed;
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
    const quota: Record<string, string> = {};
    resp.headers.forEach((value, name) => {
      if (name.startsWith("x-quota-") || name.startsWith("x-ratelimit-") || name === "retry-after") quota[name] = value;
    });
    return { status: resp.status, ok: resp.ok, body: await resp.text(), quota };
  }
}
