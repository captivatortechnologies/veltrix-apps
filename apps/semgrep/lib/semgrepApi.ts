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
/**
 * Root host for API families that are NOT rooted at /api/v1 — notably the
 * Policies V2 surface (`/api/policies/v2/...`), confirmed public + documented
 * at https://docs.semgrep.dev/api-reference/v2/ (distinct from the internal-use
 * `/api/agent/...` family on the same v2 spec, which is Experimental / JWT-only
 * and out of scope — see the Coverage section of README.md).
 */
export const SEMGREP_ROOT_URL = 'https://semgrep.dev'
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

// ---------------------------------------------------------------------------
// Policies V2 ([Beta]) types — protos.policies.v2.* in the v2 OpenAPI spec
// (https://semgrep.dev/api/v2/openapi.yaml), documented at
// https://docs.semgrep.dev/api-reference/v2/. Field names are kept exactly as
// the wire schema declares them (including snake_case) so a hand-authored
// canvas JSON blob matches what Semgrep's own docs and dry-run error messages
// reference.
// ---------------------------------------------------------------------------

/** Detection policy bundles exist for exactly these two products. */
export type DetectionPolicyProduct = 'code' | 'secrets'

/** A per-project or per-tag rule exception. Exactly one of project / project_tag_name must be set. */
export interface DetectionPolicyException {
  exception_type: 'include' | 'exclude'
  project?: string
  project_tag_name?: string
  rule: string
  rule_type: 'rule' | 'pack'
}

/** The full declared detection state for one product. A strict apply replaces the entire bundle. */
export interface DetectionPolicyBundle {
  /** Output-only when read; optional on write (must match the {product} path segment when set). */
  product?: string
  rulesets?: string[]
  rules?: string[]
  disabled?: string[]
  exceptions?: DetectionPolicyException[]
}

/** A single condition of a remediation policy (accepted `type` values come from the vocab endpoint). */
export interface RemediationPolicyCondition {
  type: string
  values: string[]
  mode?: 'any' | 'none'
}

/** How a remediation policy decides whether a finding matches. */
export interface RemediationPolicyFilters {
  mode: 'all' | 'any'
  conditions: RemediationPolicyCondition[]
}

/** A single action of a remediation policy. `config` is action-type-specific (jira, webhook, slack_app, …). */
export interface RemediationPolicyAction {
  type: string
  config?: Record<string, string>
}

/** A remediation policy: conditions that fire actions when a finding matches. */
export interface RemediationPolicy {
  /** Immutable public identity after create. Required here (never left server-derived) for stable canvas identity. */
  slug?: string
  name: string
  description?: string
  active?: boolean
  filters: RemediationPolicyFilters
  actions: RemediationPolicyAction[]
}

/** The full declared set of remediation policies for a deployment (system-managed policies excluded). */
export interface RemediationPoliciesBundle {
  policies: RemediationPolicy[]
}

/** One problem a dry run (or a rejected strict apply) reports against a candidate bundle. */
export interface BundleValidationError {
  code?: string
  message?: string
  /** The remediation policy slug the error applies to; empty for bundle-wide / detection-policy errors. */
  policy_slug?: string
  context?: Record<string, string>
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

  /** A raw request against the fixed v1 base URL. Never throws on a non-2xx status. */
  request(
    method: SemgrepMethod,
    path: string,
    opts: { query?: Record<string, string | string[] | number | undefined>; body?: unknown } = {},
  ): Promise<SemgrepResponse> {
    return this.doRequest(SEMGREP_BASE_URL, method, path, opts)
  }

  /**
   * A raw request against the Semgrep root host, for API families whose paths
   * carry their own prefix (e.g. Policies V2's `/api/policies/v2/...`) rather
   * than living under the fixed v1 base URL. Supports extra headers — the
   * Policies V2 optimistic-concurrency contract requires `If-Match`.
   */
  requestV2(
    method: SemgrepMethod,
    path: string,
    opts: { query?: Record<string, string | string[] | number | undefined>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<SemgrepResponse> {
    return this.doRequest(SEMGREP_ROOT_URL, method, path, opts)
  }

  private async doRequest(
    baseUrl: string,
    method: SemgrepMethod,
    path: string,
    opts: {
      query?: Record<string, string | string[] | number | undefined>
      body?: unknown
      headers?: Record<string, string>
    } = {},
  ): Promise<SemgrepResponse> {
    const url = new URL(`${baseUrl}${path}`)
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
          ...(opts.headers ?? {}),
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

  /**
   * Resolve the numeric deployment id Policies V2 paths key on (unlike the v1
   * surface, which keys on the slug). Prefers the deployment matching the
   * configured slug; falls back to the sole entry GET /deployments returns
   * ("Currently available auth scope does not extend over more than one
   * deployment" per the OpenAPI spec).
   */
  async resolveDeploymentId(): Promise<{ id: number } | { error: string }> {
    const res = await this.listDeployments()
    if (!res.ok) return { error: `Failed to resolve the Semgrep deployment id: ${semgrepErrorMessage(res)}` }
    const id = deploymentIdFromResponse(res, this.slug)
    if (id === null) {
      return { error: 'Could not resolve a numeric Semgrep deployment id for this token (GET /deployments returned none).' }
    }
    return { id }
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

  // ---------------------------------------------------------------------------
  // Policies V2 ([Beta] — /api/policies/v2, numeric deploymentId, root host).
  // The current, non-deprecated replacement for the v1 Policies API (`PUT
  // .../policies/{id}` carries `deprecated: true` in the v1 spec). Every write
  // is a strict, optimistically-concurrent whole-bundle replace guarded by an
  // `If-Match: state_version` header, with a dry-run preview endpoint that
  // validates + diffs a candidate bundle without changing anything.
  // ---------------------------------------------------------------------------

  /** GET the detection policy bundle for one product ("code" or "secrets"). */
  getDetectionPolicy(deploymentId: number, product: DetectionPolicyProduct): Promise<SemgrepResponse> {
    return this.requestV2('GET', `/api/policies/v2/deployments/${deploymentId}/detection-policy/${product}`)
  }

  /**
   * PUT a strict apply of one product's detection policy bundle — it REPLACES
   * the current state; exceptions absent from it are deleted. `ifMatch` must be
   * the product's current `state_version` (428 if missing, 409 if stale).
   */
  applyDetectionPolicy(
    deploymentId: number,
    product: DetectionPolicyProduct,
    bundle: DetectionPolicyBundle,
    ifMatch: string,
  ): Promise<SemgrepResponse> {
    return this.requestV2('PUT', `/api/policies/v2/deployments/${deploymentId}/detection-policy/${product}`, {
      body: { bundle },
      headers: { 'If-Match': ifMatch },
    })
  }

  /** POST a dry-run preview of a candidate detection policy bundle — validates + diffs, never writes. */
  dryRunDetectionPolicy(
    deploymentId: number,
    product: DetectionPolicyProduct,
    bundle: DetectionPolicyBundle,
  ): Promise<SemgrepResponse> {
    return this.requestV2('POST', `/api/policies/v2/deployments/${deploymentId}/detection-policy/${product}:dryRun`, {
      body: { bundle },
    })
  }

  /** GET the deployment's whole remediation-policies bundle (system-managed policies excluded). */
  getRemediationPolicies(deploymentId: number): Promise<SemgrepResponse> {
    return this.requestV2('GET', `/api/policies/v2/deployments/${deploymentId}/remediation-policies`)
  }

  /**
   * PUT a strict apply of the deployment's whole remediation-policies bundle —
   * the submitted list REPLACES the current state; policies absent from it are
   * deleted. `ifMatch` must be the bundle's current `state_version`.
   */
  applyRemediationPolicies(
    deploymentId: number,
    bundle: RemediationPoliciesBundle,
    ifMatch: string,
  ): Promise<SemgrepResponse> {
    return this.requestV2('PUT', `/api/policies/v2/deployments/${deploymentId}/remediation-policies`, {
      body: { bundle },
      headers: { 'If-Match': ifMatch },
    })
  }

  /** POST a dry-run preview of a candidate remediation-policies bundle — validates + diffs, never writes. */
  dryRunRemediationPolicies(deploymentId: number, bundle: RemediationPoliciesBundle): Promise<SemgrepResponse> {
    return this.requestV2('POST', `/api/policies/v2/deployments/${deploymentId}/remediation-policies:dryRun`, {
      body: { bundle },
    })
  }

  /** GET the accepted condition/action types + value enums, optionally scoped to one product ("code" | "secrets" | "remediation"). */
  getPolicyVocab(deploymentId: number, product?: string): Promise<SemgrepResponse> {
    return this.requestV2('GET', `/api/policies/v2/deployments/${deploymentId}/vocab`, {
      query: { product },
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

/**
 * Resolve the numeric deployment id matching `slug` from a GET /deployments
 * response body — preferring an exact slug match, falling back to the sole
 * entry when `slug` is unset or not found among the (normally single) results.
 * Policies V2 paths key on this numeric id, unlike the v1 surface (slug).
 */
export function deploymentIdFromResponse(res: SemgrepResponse, slug: string | null): number | null {
  const j = res.json as { deployments?: SemgrepDeployment[] } | null
  const records = j && Array.isArray(j.deployments) ? j.deployments : []
  if (records.length === 0) return null
  const match = slug ? records.find((d) => d.slug === slug) : undefined
  const chosen = match ?? records[0]
  return typeof chosen.id === 'number' ? chosen.id : null
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

// ---------------------------------------------------------------------------
// Policies V2 response helpers. GET / apply / dry-run responses for BOTH
// detection-policy and remediation-policies share the same envelope shape
// (`{ bundle, state_version }` on read/apply, `{ creates, updates, deletes,
// state_version, validation_errors }` on dry run) — one pair of generic
// helpers covers both config types.
// ---------------------------------------------------------------------------

/** Extract the detection policy bundle from a GET / apply response body. */
export function detectionPolicyBundleFromResponse(res: SemgrepResponse): DetectionPolicyBundle | null {
  const j = res.json as { bundle?: DetectionPolicyBundle } | null
  return j?.bundle ?? null
}

/** Extract the remediation policies bundle from a GET / apply response body. */
export function remediationPoliciesBundleFromResponse(res: SemgrepResponse): RemediationPoliciesBundle | null {
  const j = res.json as { bundle?: RemediationPoliciesBundle } | null
  return j?.bundle ?? null
}

/** Extract `state_version` from a Policies V2 GET / apply / dry-run response body. */
export function stateVersionFromResponse(res: SemgrepResponse): string | null {
  const j = res.json as { state_version?: unknown } | null
  return typeof j?.state_version === 'string' && j.state_version.length > 0 ? j.state_version : null
}

/** Extract the `validation_errors` a dry run (or a rejected strict apply) reports against a candidate bundle. */
export function validationErrorsFromResponse(res: SemgrepResponse): BundleValidationError[] {
  const j = res.json as { validation_errors?: BundleValidationError[] } | null
  return Array.isArray(j?.validation_errors) ? j.validation_errors : []
}

/**
 * Apply a Policies V2 strict-apply call under its `If-Match: state_version`
 * optimistic-concurrency contract. Tries once with `initialVersion`; on a 409
 * (stale) or 428 (missing header — shouldn't occur since a version is always
 * sent) response, re-reads the CURRENT `state_version` via `getFreshVersion`
 * and retries exactly once. A persistent conflict (or a failed re-read) simply
 * returns that second attempt's response, surfacing as a normal write error to
 * the caller — this never loops, so a genuinely contested resource fails fast
 * rather than retrying indefinitely.
 */
export async function applyWithOptimisticRetry(
  attempt: (ifMatch: string) => Promise<SemgrepResponse>,
  getFreshVersion: () => Promise<string | null>,
  initialVersion: string,
): Promise<SemgrepResponse> {
  const first = await attempt(initialVersion)
  if (first.status !== 409 && first.status !== 428) return first
  const fresh = await getFreshVersion()
  if (!fresh) return first
  return attempt(fresh)
}
