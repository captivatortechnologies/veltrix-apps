const STATUS_HINTS: Record<number, string> = {
  400: 'Bad request — check the tool arguments against the described schema.',
  401: 'Authentication failed — the API key is missing, invalid, revoked, or expired.',
  402: 'Payment required — the tenant trial has lapsed or a chargeable payment method is missing. Resolve billing in the Veltrix portal.',
  403: 'Forbidden — the API key’s bound role lacks the required permission for this operation. Ask a Veltrix admin to adjust the key’s role.',
  404: 'Not found — the resource does not exist or belongs to another tenant.',
  429: 'Rate limit or tier quota exceeded — retry later or upgrade the plan.',
};

export class VeltrixApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'VeltrixApiError';
  }

  static from(status: number, body: unknown): VeltrixApiError {
    let detail: string | undefined;
    if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
      detail = (body as { error: string }).error;
    } else if (typeof body === 'string' && body.trim()) {
      detail = body.trim().slice(0, 500);
    }
    const hint = STATUS_HINTS[status] ?? 'The Veltrix API rejected the request.';
    const message = `Veltrix API error ${status}: ${detail ?? 'no error detail'}. ${hint}`;
    return new VeltrixApiError(status, detail, message);
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
}

export interface VeltrixClientOptions {
  /** Per-request timeout in ms. Kept below typical MCP client timeouts (60s) so callers get a clear error, not a protocol timeout. */
  timeoutMs?: number;
  /**
   * Check the tenant's tier entitlement (GET /api/subscription/mcp-access)
   * before the first real request and refuse tool calls when MCP access is
   * not included in the plan. On platforms without the endpoint (404) the
   * gate is treated as open for backward compatibility.
   */
  enforceEntitlement?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MCP_ENTITLEMENT_PATH = '/api/subscription/mcp-access';

/**
 * Thin REST adapter over the Veltrix API. Forwards the caller's API key on
 * every request; all authorization (tenant isolation, RBAC, quotas, trial
 * gates, rate limits) is enforced server-side by the Veltrix API itself.
 */
export class VeltrixClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly enforceEntitlement: boolean;
  private entitlementPromise?: Promise<void>;

  constructor(baseUrl: string, private readonly apiKey: string, options: VeltrixClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.enforceEntitlement = options.enforceEntitlement ?? false;
  }

  /**
   * Memoized tier-entitlement gate. A confirmed "enabled" is cached for the
   * client's lifetime; failures (including a disabled tier) are re-checked on
   * the next call so transient errors recover and upgrades apply immediately.
   */
  private ensureEntitled(): Promise<void> {
    if (!this.entitlementPromise) {
      this.entitlementPromise = this.checkEntitlement().catch((error) => {
        this.entitlementPromise = undefined;
        throw error;
      });
    }
    return this.entitlementPromise;
  }

  private async checkEntitlement(): Promise<void> {
    let result: { enabled?: boolean; tier?: string };
    try {
      result = await this.request<{ enabled?: boolean; tier?: string }>('GET', MCP_ENTITLEMENT_PATH, {}, true);
    } catch (error) {
      if (error instanceof VeltrixApiError && error.status === 404) return; // older platform: no gate
      throw error;
    }
    if (result?.enabled === false) {
      throw new VeltrixApiError(
        403,
        undefined,
        `MCP access is not included in this tenant's current plan (tier "${result.tier ?? 'free'}"). ` +
          'Upgrade the Veltrix subscription in the portal to use AI-assistant access.',
      );
    }
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}, skipEntitlement = false): Promise<T> {
    if (this.enforceEntitlement && !skipEntitlement) {
      await this.ensureEntitled();
    }
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new VeltrixApiError(
          0,
          undefined,
          `Veltrix API request timed out after ${this.timeoutMs}ms (${method} ${path}). The API may be slow or unreachable.`,
        );
      }
      if (error instanceof TypeError) {
        throw new VeltrixApiError(
          0,
          undefined,
          `Could not reach the Veltrix API at ${this.baseUrl} — connection failed. Check VELTRIX_API_URL and that the platform is running.`,
        );
      }
      throw error;
    }

    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      throw VeltrixApiError.from(response.status, data);
    }
    return data as T;
  }

  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, { body, query });
  }

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body });
  }

  delete<T = unknown>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }
}
