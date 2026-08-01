// =============================================================================
// GitHub REST API client.
//
// Auth is a token (fine-grained PAT, classic PAT, or GitHub App installation
// token) sent as `Authorization: Bearer <token>`. Every request also carries the
// version pin `X-GitHub-Api-Version: 2022-11-28` (the stable default), the
// `Accept: application/vnd.github+json` media type, and a `User-Agent` — GitHub
// rejects requests without a User-Agent with 403.
//
// Base URL is https://api.github.com for GitHub.com. GitHub Enterprise Server
// (GHES) is reached at https://<host>/api/v3 — resolved from the connection
// endpoint, and overridable with the `api_base_url` app setting.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect `status`/`ok` so they
// can tell a 404 from a real failure.
//
// Docs (verified against docs.github.com/rest):
//   - Update a repository (security_and_analysis):
//     https://docs.github.com/en/rest/repos/repos#update-a-repository
//   - Code scanning default setup:
//     https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-default-setup-configuration
//   - Dependabot security updates (automated security fixes):
//     https://docs.github.com/en/rest/repos/repos#enable-automated-security-fixes
//   - API versions: https://docs.github.com/en/rest/about-the-rest-api/api-versions
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** GitHub.com REST base. */
export const GITHUB_CLOUD_API = 'https://api.github.com'
/** Stable, default X-GitHub-Api-Version (fully supported; requests without it default here). */
export const GITHUB_API_VERSION = '2022-11-28'
/** GitHub rejects API requests that carry no User-Agent (HTTP 403). */
export const GITHUB_USER_AGENT = 'veltrix-github-advanced-security'

const REQUEST_TIMEOUT_MS = 20_000

export const MISSING_CREDENTIAL_MESSAGE =
  'No GitHub token available — create a personal access token (or GitHub App installation token) ' +
  'with repository administration and code-security permissions, and store it in the credential ' +
  '"API token" field.'

export type GithubMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface GithubResponse {
  status: number
  ok: boolean
  body: string
}

/** Extract the GitHub token from a Veltrix credential ("API token" or "password"). */
export function resolveGithubToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

/**
 * Resolve the REST base URL for a connection.
 *   1. `api_base_url` app setting wins (explicit override, e.g. a GHES base).
 *   2. A GitHub.com host (empty / api.github.com / github.com) → https://api.github.com.
 *   3. Any other host is treated as GHES → https://<host>/api/v3.
 * The returned value never has a trailing slash.
 */
export function buildGithubBaseUrl(rawHost: string | undefined | null, settings: Record<string, unknown> = {}): string {
  const override = settings.api_base_url
  if (typeof override === 'string' && override.trim()) {
    return override.trim().replace(/\/+$/, '')
  }

  let host = (rawHost ?? '').trim().toLowerCase()
  host = host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '')

  if (!host || host === 'api.github.com' || host === 'github.com' || host === 'www.github.com') {
    return GITHUB_CLOUD_API
  }
  return `https://${host}/api/v3`
}

/** Parse a JSON body, returning null instead of throwing on malformed/empty content. */
export function parseJson<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from GitHub's `{ message, errors[] }` envelope. */
export function githubErrorMessage(res: GithubResponse): string {
  const env = parseJson<{ message?: string; errors?: Array<{ message?: string; code?: string }> }>(res.body)
  const detail = env?.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ')
  if (env?.message) return detail ? `${env.message} (${detail})` : env.message
  return res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`
}

/**
 * A thin GitHub REST client bound to one base URL + token. Methods return the raw
 * `{ status, ok, body }` so callers distinguish a 404 (skip) from a real failure.
 */
export class GithubClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(opts: { baseUrl: string; token: string; timeoutMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS
  }

  async request(method: GithubMethod, path: string, body?: unknown): Promise<GithubResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': GITHUB_USER_AGENT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

  /** GET the authenticated user — the connectivity / token check. */
  getAuthenticatedUser(): Promise<GithubResponse> {
    return this.request('GET', '/user')
  }

  /** GET a repository (carries the `security_and_analysis` block used for drift/rollback). */
  getRepo(owner: string, repo: string): Promise<GithubResponse> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  }

  /** PATCH a repository with a partial `{ security_and_analysis: {...} }` body. */
  updateRepo(owner: string, repo: string, body: Record<string, unknown>): Promise<GithubResponse> {
    return this.request('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, body)
  }

  /** GET the Dependabot security-updates (automated security fixes) state: `{ enabled, paused }`. */
  getAutomatedSecurityFixes(owner: string, repo: string): Promise<GithubResponse> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/automated-security-fixes`)
  }

  /** Enable (PUT) or disable (DELETE) Dependabot security updates. */
  setAutomatedSecurityFixes(owner: string, repo: string, enabled: boolean): Promise<GithubResponse> {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/automated-security-fixes`
    return this.request(enabled ? 'PUT' : 'DELETE', path)
  }

  /** GET the code-scanning default-setup configuration: `{ state, languages, query_suite, ... }`. */
  getCodeScanningDefaultSetup(owner: string, repo: string): Promise<GithubResponse> {
    return this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-scanning/default-setup`)
  }

  /** PATCH the code-scanning default-setup configuration (`state: configured | not-configured`). */
  updateCodeScanningDefaultSetup(owner: string, repo: string, body: Record<string, unknown>): Promise<GithubResponse> {
    return this.request(
      'PATCH',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-scanning/default-setup`,
      body,
    )
  }
}

/** Build a client from a raw endpoint host, a credential and app settings. */
export function buildGithubClient(
  rawHost: string | undefined | null,
  credential: CredentialRef | null,
  settings: Record<string, unknown> = {},
): { client: GithubClient; baseUrl: string } | { error: string } {
  const token = resolveGithubToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }
  const baseUrl = buildGithubBaseUrl(rawHost, settings)
  return { client: new GithubClient({ baseUrl, token }), baseUrl }
}
