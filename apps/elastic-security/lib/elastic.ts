// =============================================================================
// Elastic Security client — speaks to BOTH Kibana and Elasticsearch.
//
// Elastic Security config lives across two endpoints:
//   - Kibana        (detection rules, exception lists, spaces): /api/...
//   - Elasticsearch (ILM policies, role mappings):              /_ilm, /_security
// An Elastic API key authenticates both, sent as `Authorization: ApiKey <key>`.
// Kibana additionally requires `kbn-xsrf: true` on state-changing requests and
// `elastic-api-version` on its versioned Security endpoints.
//
// The component hostname is the Kibana base URL; the Elasticsearch base URL is
// an app setting. Handlers run in-process, so this uses fetch with an
// AbortController timeout and never throws on an HTTP error status.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

const REQUEST_TIMEOUT_MS = 30_000

/** Version header value for Kibana's versioned Security Solution endpoints. */
export const KIBANA_API_VERSION = '2023-10-31'

export interface ElasticSettings {
  /** Elasticsearch base URL (Kibana base URL comes from the component hostname). */
  elasticsearchUrl: string | null
  /** Kibana space to scope space-aware requests to; null = default space. */
  space: string | null
  timeoutMs: number
}

export function readElasticSettings(settings: Record<string, unknown>): ElasticSettings {
  const rawEs = settings.elasticsearch_url
  const elasticsearchUrl =
    typeof rawEs === 'string' && rawEs.trim().length > 0 ? rawEs.trim().replace(/\/+$/, '') : null

  const rawSpace = settings.space
  const space = typeof rawSpace === 'string' && rawSpace.trim().length > 0 ? rawSpace.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { elasticsearchUrl, space, timeoutMs }
}

/**
 * Extract the Elastic API key from a Veltrix credential.
 * Convention: the base64 `id:api_key` string in "API token" (preferred) or
 * "password". If username + password are both set instead, fall back to Basic.
 */
export function resolveElasticAuth(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const apiKey = (credential.apiToken ?? '').trim()
  if (apiKey) return `ApiKey ${apiKey}`
  const user = credential.username?.trim()
  const pass = (credential.password ?? '').trim()
  if (user && pass) return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  return null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Elastic credential available — store an Elastic API key (the base64 "id:api_key" value) in ' +
  'the credential "API token" field (create one in Kibana under Stack Management > API keys), or ' +
  'store a username + password for Basic auth. The key needs privileges for what this app manages.'

export interface ElasticResponse {
  status: number
  ok: boolean
  body: string
}

export type ElasticMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type ElasticTarget = 'kibana' | 'elasticsearch'

export class ElasticClient {
  private readonly kibanaUrl: string
  private readonly elasticsearchUrl: string | null
  private readonly auth: string
  private readonly space: string | null
  private readonly timeoutMs: number

  constructor(opts: {
    kibanaUrl: string
    elasticsearchUrl: string | null
    auth: string
    space: string | null
    timeoutMs: number
  }) {
    this.kibanaUrl = opts.kibanaUrl.replace(/\/+$/, '')
    this.elasticsearchUrl = opts.elasticsearchUrl ? opts.elasticsearchUrl.replace(/\/+$/, '') : null
    this.auth = opts.auth
    this.space = opts.space
    this.timeoutMs = opts.timeoutMs
  }

  /**
   * A Kibana request. Adds `kbn-xsrf: true` and the Security Solution API
   * version header (required on 8.x+ /api endpoints, harmless elsewhere), and
   * prefixes `/s/{space}` when a space is set. Pass `opts.space` to target a
   * specific space (overriding the client default); '' or 'default' means no
   * prefix.
   */
  async kibana(
    method: ElasticMethod,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
      space?: string | null
    } = {},
  ): Promise<ElasticResponse> {
    const space = opts.space === undefined ? this.space : opts.space
    const prefix = space && space !== 'default' ? `/s/${encodeURIComponent(space)}` : ''
    const headers: Record<string, string> = {
      'kbn-xsrf': 'true',
      'elastic-api-version': KIBANA_API_VERSION,
    }
    return this.send(`${this.kibanaUrl}${prefix}`, method, path, headers, opts.query, opts.body)
  }

  /** An Elasticsearch request (ILM, role mappings). Requires the ES URL setting. */
  async elasticsearch(
    method: ElasticMethod,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<ElasticResponse> {
    if (!this.elasticsearchUrl) {
      return {
        status: 0,
        ok: false,
        body: JSON.stringify({
          error: {
            reason:
              'No Elasticsearch URL configured — set the "Elasticsearch URL" app setting to manage ILM policies and role mappings.',
          },
        }),
      }
    }
    return this.send(this.elasticsearchUrl, method, path, {}, opts.query, opts.body)
  }

  private async send(
    base: string,
    method: ElasticMethod,
    path: string,
    extraHeaders: Record<string, string>,
    query: Record<string, string | number | boolean | undefined> | undefined,
    body: unknown,
  ): Promise<ElasticResponse> {
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: this.auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Build a client from a component hostname (Kibana URL), a credential and settings. */
export function buildElasticClient(
  hostname: string | undefined,
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: ElasticClient; kibanaUrl: string } | { error: string } {
  const auth = resolveElasticAuth(credential)
  if (!auth) return { error: MISSING_CREDENTIAL_MESSAGE }

  const host = hostname?.trim()
  if (!host) {
    return {
      error:
        'No Kibana URL — register a component whose hostname is the Kibana base URL ' +
        '(e.g. https://my-deployment.kb.us-central1.gcp.cloud.es.io:9243).',
    }
  }

  const resolved = readElasticSettings(settings)
  const kibanaUrl = host.startsWith('http') ? host.replace(/\/+$/, '') : `https://${host.replace(/\/+$/, '')}`

  return {
    client: new ElasticClient({
      kibanaUrl,
      elasticsearchUrl: resolved.elasticsearchUrl,
      auth,
      space: resolved.space,
      timeoutMs: resolved.timeoutMs,
    }),
    kibanaUrl,
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from an Elastic/Kibana error response body. */
export function elasticErrorMessage(res: ElasticResponse): string {
  const parsed = parseJson<{
    message?: string
    error?: string | { reason?: string; type?: string }
    // Kibana Security errors sometimes carry a nested list of failures.
    attributes?: { error?: { message?: string } }
  }>(res.body)
  if (!parsed) return res.body || `HTTP ${res.status}`
  if (typeof parsed.error === 'object' && parsed.error?.reason) return parsed.error.reason
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  if (parsed.message) return parsed.message
  if (parsed.attributes?.error?.message) return parsed.attributes.error.message
  return res.body || `HTTP ${res.status}`
}
