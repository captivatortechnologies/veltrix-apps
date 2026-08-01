// =============================================================================
// Semgrep AppSec Platform public API (v1) client.
//
// Semgrep exposes ONE hosted REST API with a FIXED base URL:
//   https://semgrep.dev/api/v1
// (Confirmed from the official OpenAPI spec, https://semgrep.dev/api/v1/public_v1.openapi.yaml.)
// There is no region/tenant host — the deployment SLUG identifies the tenant and
// is carried in every project path, e.g.
//   GET   /deployments
//   GET   /deployments/{slug}/projects
//   GET   /deployments/{slug}/projects/{projectName}
//   PATCH /deployments/{slug}/projects/{projectName}
//   PATCH /deployments/{slug}/projects/{projectName}/managed-scan
//   PUT   /deployments/{slug}/projects/{projectName}/tags
//   DELETE/deployments/{slug}/projects/{projectName}/tags?tags=…
//   GET   /deployments/{slug}/findings
//   POST  /deployments/{slug}/triage
//
// Auth is a single Semgrep API token sent as a Bearer header on every call:
//   Authorization: Bearer <token>
// (SemgrepWebToken in the spec.) The token is provisioned in the Semgrep AppSec
// Platform under Settings > Tokens (Team/Enterprise tier) and is stored on the
// connection credential's apiToken (falling back to password).
//
// The deployment slug is an app setting (deployment_slug). GET /deployments
// returns the single deployment the token can access, so the slug is also
// auto-discoverable — resolveDeploymentSlug() falls back to it when the setting
// is blank.
//
// Handlers run in-process, so this uses fetch with an AbortController timeout and
// never throws on an HTTP error status — callers inspect status/ok/json.
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** The Semgrep public API base URL is fixed — there is no region or tenant host. */
export const SEMGREP_BASE_URL = 'https://semgrep.dev/api/v1'
const REQUEST_TIMEOUT_MS = 30_000

export interface SemgrepSettings {
  /** The deployment slug (app setting), or null when unset — resolvable from GET /deployments. */
  deploymentSlug: string | null
  timeoutMs: number
}

export function readSemgrepSettings(settings: Record<string, unknown>): SemgrepSettings {
  const rawSlug = settings.deployment_slug
  const deploymentSlug = typeof rawSlug === 'string' && rawSlug.trim().length > 0 ? rawSlug.trim() : null

  const rawTimeout = settings.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : REQUEST_TIMEOUT_MS

  return { deploymentSlug, timeoutMs }
}

/** Extract the Semgrep API token from a Veltrix credential ("API token" or "password"). */
export function resolveSemgrepToken(credential: CredentialRef | null): string | null {
  if (!credential) return null
  const token = (credential.apiToken ?? credential.password ?? '').trim()
  return token.length > 0 ? token : null
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No Semgrep API token available — provision one in the Semgrep AppSec Platform under ' +
  'Settings > Tokens (Team or Enterprise tier) and store it in the credential "API token" field. ' +
  'It is sent as an "Authorization: Bearer <token>" header.'

export const MISSING_SLUG_MESSAGE =
  'No Semgrep deployment slug — set the "Deployment Slug" app setting. Find it at ' +
  'GET /api/v1/deployments or in the Semgrep AppSec Platform under Settings.'

export interface SemgrepResponse {
  status: number
  ok: boolean
  body: string
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  json: unknown
}

export type SemgrepMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface SemgrepDeployment {
  id?: number
  name?: string
  slug?: string
}

/**
 * Managed Scans configuration for a project ([Beta] per the OpenAPI spec's
 * `ManagedScanConfig`). `full_scan.enabled` = weekly full scans; `diff_scan.enabled`
 * = diff-aware (PR) scans. Returned on the project (GET) and written by the
 * managed-scan PATCH.
 */
export interface SemgrepManagedScanConfig {
  full_scan?: { enabled?: boolean }
  diff_scan?: { enabled?: boolean }
}

/** A Semgrep project as returned by GET .../projects and .../projects/{name}. */
export interface SemgrepProject {
  id?: number
  name?: string
  tags?: string[]
  primary_branch?: string
  default_branch?: string
  url?: string
  created_at?: string
  latest_scan_at?: string
  managed_scan_config?: SemgrepManagedScanConfig
  [key: string]: unknown
}

export class SemgrepClient {
  private readonly token: string
  private readonly slug: string | null
  private readonly timeoutMs: number

  constructor(opts: { token: string; deploymentSlug: string | null; timeoutMs: number }) {
    this.token = opts.token
    this.slug = opts.deploymentSlug
    this.timeoutMs = opts.timeoutMs
  }

  get hasSlug(): boolean {
    return this.slug !== null
  }

  /** The deployment slug; throws MISSING_SLUG_MESSAGE when unset. */
  deploymentSlug(): string {
    if (!this.slug) throw new Error(MISSING_SLUG_MESSAGE)
    return this.slug
  }

  /** A raw request against the fixed base URL. Never throws on a non-2xx status. */
  async request(
    method: SemgrepMethod,
    path: string,
    opts: { query?: Record<string, string | string[] | number | undefined>; body?: unknown } = {},
  ): Promise<SemgrepResponse> {
    const url = new URL(`${SEMGREP_BASE_URL}${path}`)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, String(v))
      } else {
        url.searchParams.set(key, String(value))
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      })
      const text = await res.text()
      return { status: res.status, ok: res.status >= 200 && res.status < 300, body: text, json: parseJson(text) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Connectivity probe: the deployment(s) the token can access. */
  listDeployments(): Promise<SemgrepResponse> {
    return this.request('GET', '/deployments')
  }

  /** GET a single project by name (the repository as a path). */
  getProject(projectName: string): Promise<SemgrepResponse> {
    return this.request('GET', `/deployments/${this.deploymentSlug()}/projects/${projectPath(projectName)}`)
  }

  /** PATCH a project's attributes (primary_branch, tags, …). */
  updateProject(projectName: string, body: Record<string, unknown>): Promise<SemgrepResponse> {
    return this.request('PATCH', `/deployments/${this.deploymentSlug()}/projects/${projectPath(projectName)}`, { body })
  }

  /**
   * PATCH a project's Managed Scans configuration ([Beta] endpoint). Body carries
   * `full_scan` and/or `diff_scan` toggles. Only valid when the deployment has
   * Semgrep Managed Scanning enabled for the project.
   */
  updateManagedScan(
    projectName: string,
    body: { full_scan?: { enabled: boolean }; diff_scan?: { enabled: boolean } },
  ): Promise<SemgrepResponse> {
    return this.request(
      'PATCH',
      `/deployments/${this.deploymentSlug()}/projects/${projectPath(projectName)}/managed-scan`,
      { body },
    )
  }

  /**
   * GET findings for the deployment, filtered by the given query (issue_type,
   * status, repos, rules, severities, …). Read-only — used by triage drift.
   */
  listFindings(query: Record<string, string | string[] | number | undefined>): Promise<SemgrepResponse> {
    return this.request('GET', `/deployments/${this.deploymentSlug()}/findings`, { query })
  }

  /**
   * POST a bulk triage. `body` selects the findings (by issue_ids or filters) and
   * declares the new triage state / reason / note. Imperative — there is no
   * server-side triage-rule object; this applies to the findings that match now.
   */
  bulkTriage(body: Record<string, unknown>): Promise<SemgrepResponse> {
    return this.request('POST', `/deployments/${this.deploymentSlug()}/triage`, { body })
  }

  /** PUT tags onto a project (additive — tags not present are created + associated). */
  addProjectTags(projectName: string, tags: string[]): Promise<SemgrepResponse> {
    return this.request('PUT', `/deployments/${this.deploymentSlug()}/projects/${projectPath(projectName)}/tags`, {
      body: { tags },
    })
  }

  /** DELETE tags from a project (only removes them from THIS project). */
  removeProjectTags(projectName: string, tags: string[]): Promise<SemgrepResponse> {
    return this.request('DELETE', `/deployments/${this.deploymentSlug()}/projects/${projectPath(projectName)}/tags`, {
      query: { tags },
    })
  }
}

/**
 * Encode a project name for use as a path segment. Project names are a repository
 * path such as "my-org/my-repo"; the Semgrep API's {projectName} path parameter
 * matches the slash literally (the OpenAPI example is "organization/project"), so
 * the slash is preserved and only the other characters of each segment are
 * percent-encoded.
 */
export function projectPath(projectName: string): string {
  return projectName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** Build a client from a credential and settings. */
export function buildSemgrepClient(
  credential: CredentialRef | null,
  settings: Record<string, unknown>,
): { client: SemgrepClient } | { error: string } {
  const token = resolveSemgrepToken(credential)
  if (!token) return { error: MISSING_CREDENTIAL_MESSAGE }

  const resolved = readSemgrepSettings(settings)
  return {
    client: new SemgrepClient({ token, deploymentSlug: resolved.deploymentSlug, timeoutMs: resolved.timeoutMs }),
  }
}

/** Parse a JSON body, returning null instead of throwing on malformed content. */
export function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : null
  } catch {
    return null
  }
}

/** Extract a human-readable error from a Semgrep API error response. Never throws. */
export function semgrepErrorMessage(res: SemgrepResponse): string {
  const j = res.json as { message?: unknown; error?: unknown; detail?: unknown; errors?: unknown } | null
  if (j && typeof j === 'object') {
    if (typeof j.message === 'string' && j.message) return j.message
    if (typeof j.detail === 'string' && j.detail) return j.detail
    if (typeof j.error === 'string' && j.error) return j.error
  }
  const trimmed = (res.body || '').trim()
  if (trimmed) return trimmed.slice(0, 200)
  return `HTTP ${res.status}`
}

/**
 * Inspect a write response and return an error message when Semgrep rejected it,
 * or null on success. NON-UNION `string | null` (the platform handler loader
 * cannot narrow discriminated unions).
 */
export function semgrepWriteError(res: SemgrepResponse): string | null {
  if (!res.ok) return semgrepErrorMessage(res)
  return null
}

/** Extract the list of deployment slugs from a GET /deployments response body. */
export function deploymentSlugs(res: SemgrepResponse): string[] {
  const j = res.json as { deployments?: SemgrepDeployment[] } | null
  if (!j || !Array.isArray(j.deployments)) return []
  return j.deployments.map((d) => (typeof d.slug === 'string' ? d.slug : '')).filter((s) => s.length > 0)
}

/** Extract a single project from a GET .../projects/{name} response body. */
export function projectFromResponse(res: SemgrepResponse): SemgrepProject | null {
  const j = res.json as { project?: SemgrepProject } | SemgrepProject | null
  if (!j || typeof j !== 'object') return null
  if ('project' in j && j.project && typeof j.project === 'object') return j.project as SemgrepProject
  if ('name' in j || 'id' in j) return j as SemgrepProject
  return null
}

/** The full-scan / diff-scan enabled flags of a project's Managed Scans config. */
export interface ManagedScanFlags {
  fullScan: boolean
  diffScan: boolean
}

/** Read the Managed Scans flags off a project (absent config reads as both off). */
export function managedScanFromProject(project: SemgrepProject | null): ManagedScanFlags {
  const cfg = project?.managed_scan_config
  return {
    fullScan: Boolean(cfg?.full_scan?.enabled),
    diffScan: Boolean(cfg?.diff_scan?.enabled),
  }
}

/** The numeric finding ids from a GET .../findings response body. */
export function findingIds(res: SemgrepResponse): number[] {
  const j = res.json as { findings?: Array<{ id?: unknown }> } | null
  if (!j || !Array.isArray(j.findings)) return []
  const ids: number[] = []
  for (const f of j.findings) {
    const id = typeof f?.id === 'number' ? f.id : Number(f?.id)
    if (Number.isFinite(id)) ids.push(id)
  }
  return ids
}

/** The number of triaged issues reported by a POST .../triage response. */
export function triagedCount(res: SemgrepResponse): number {
  const j = res.json as { num_triaged?: unknown } | null
  const n = typeof j?.num_triaged === 'number' ? j.num_triaged : Number(j?.num_triaged)
  return Number.isFinite(n) ? n : 0
}

/** The list of triaged issue ids reported by a POST .../triage response. */
export function triagedIssueIds(res: SemgrepResponse): number[] {
  const j = res.json as { triaged_issues?: unknown[] } | null
  if (!j || !Array.isArray(j.triaged_issues)) return []
  const ids: number[] = []
  for (const raw of j.triaged_issues) {
    const id = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(id)) ids.push(id)
  }
  return ids
}
