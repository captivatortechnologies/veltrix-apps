// =============================================================================
// Illumio Core (PCE) REST API v2 access seam.
//
// Base URL: https://<host>:<port>/api/v2 — confirmed against illumio-py's
// PolicyComputeEngine (`"{scheme}://{host}:{port}/api/{version}"`, version
// defaults to "v2"). Every policy-object endpoint is org-scoped:
// /orgs/{org_id}/<resource> (illumio-py PCEObjectResource._build_endpoint).
// https://github.com/illumio/illumio-py/blob/main/illumio/pce.py
//
// Auth: HTTP Basic, username = the PCE API key (e.g. "api_145a5c788e2ba897c"),
// password = the API key's secret (illumio-py `set_credentials(key, secret)`
// sets `session.auth = (key, secret)`). Confirmed against illumio-py and the
// Label docstring example (`pce.set_credentials('api_key', 'api_secret')`):
// https://github.com/illumio/illumio-py/blob/main/illumio/policyobjects/label.py
//
// On-premises PCEs commonly ship a self-signed or internal-CA certificate, so —
// same posture as this repo's other on-prem apps (axonius, tanium, rubrik,
// keycloak, ...) — the transport uses node:https directly with
// rejectUnauthorized driven by the `verify_tls` app setting (default off),
// bypassing the platform's global fetch stack, which cannot be configured
// per-request for TLS trust.
//
// Labels: GET/POST/PUT/DELETE /orgs/{org_id}/labels. A label is
// { key, value, external_data_set?, external_data_reference? } — `key` and
// `value` together ARE the identity (key is immutable after create; only
// `value`/external_data_* can be sent on a PUT). Confirmed against the
// Illumio Terraform provider's label resource + label model (Terraform
// marks the PCE label `key` ForceNew — i.e. immutable):
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/illumio-core/resource_illumio_label.go
// https://github.com/illumio/terraform-provider-illumio-core/blob/main/models/label.go
// Docs: https://docs.illumio.com/core/23.2/Content/Guides/security-policy/security-policy-objects/labels-and-label-groups.htm
//
// UNVERIFIED / OUT OF SCOPE for this release: security policy (rule_sets,
// rules, services, ip_lists, enforcement boundaries) lives under the PCE's
// draft-then-provision model — /orgs/{org_id}/sec_policy/draft/<resource> while
// editing, then POST /orgs/{org_id}/sec_policy with the changed hrefs to
// "provision" (commit) a new active policy version (confirmed shape of the
// path segment only, via illumio-py's `_build_endpoint`:
// `/sec_policy/{draft|active}/{endpoint}`). This app does not build rule_sets
// yet — planned for a follow-up release once the draft/provision flow is
// verified against a live PCE.
// =============================================================================

import { request as httpsRequest } from 'node:https'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

/** illumio-py / most on-prem PCE deployments default to port 8443 for the REST API. */
export const DEFAULT_ILLUMIO_PORT = 8443
/** Single-org PCEs use organization id 1 by default. */
export const DEFAULT_ORG_ID = 1
const DEFAULT_TIMEOUT_MS = 30_000

export interface IllumioSettings {
  /** PCE hostname, no scheme (e.g. pce.example.com). Null when unset. */
  host: string | null
  port: number
  orgId: number
  /** Enforce a valid TLS certificate. Off by default (self-signed tolerated). */
  verifyTls: boolean
  timeoutMs: number
}

export function readIllumioSettings(settings: Record<string, unknown> | undefined): IllumioSettings {
  const rawHost = settings?.host
  const host = typeof rawHost === 'string' && rawHost.trim() ? rawHost.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') : null

  const rawPort = settings?.port
  const port = typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 ? rawPort : DEFAULT_ILLUMIO_PORT

  const rawOrgId = settings?.org_id
  const orgId = typeof rawOrgId === 'number' && Number.isFinite(rawOrgId) && rawOrgId > 0 ? rawOrgId : DEFAULT_ORG_ID

  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? rawTimeout * 1000
      : DEFAULT_TIMEOUT_MS

  return { host, port, orgId, verifyTls: settings?.verify_tls === true, timeoutMs }
}

/** `https://host:port` origin for the PCE, or null when no host is configured. */
export function buildIllumioOrigin(settings: IllumioSettings): string | null {
  if (!settings.host) return null
  return `https://${settings.host}:${settings.port}`
}

/** `https://host:port/api/v2` base for the PCE REST API, or null when no host is configured. */
export function buildIllumioBaseUrl(settings: IllumioSettings): string | null {
  const origin = buildIllumioOrigin(settings)
  return origin ? `${origin}/api/v2` : null
}

/** The org-scoped path for a resource, e.g. orgPath(settings, 'labels') -> "/orgs/1/labels". */
export function orgPath(settings: IllumioSettings, resource: string): string {
  return `/orgs/${settings.orgId}/${resource.replace(/^\/+/, '')}`
}

export interface IllumioCredential {
  /** The PCE API key (e.g. "api_145a5c788e2ba897c") — the Basic auth username. */
  key: string
  /** The API key's secret — the Basic auth password. */
  secret: string
}

/**
 * Resolve the API key + secret from the connection credential. The secret is
 * accepted from either `apiToken` (the "API key secret" field under token auth)
 * or `password` (username/password auth) — both collapse to the same Basic
 * auth pair. Returns null when either half is missing.
 */
export function resolveIllumioCredential(credential: CredentialRef | null | undefined): IllumioCredential | null {
  if (!credential) return null
  const key = (credential.username ?? '').trim()
  const secret = (credential.apiToken ?? credential.password ?? '').trim()
  if (!key || !secret) return null
  return { key, secret }
}

export const MISSING_CREDENTIAL_MESSAGE =
  'No usable Illumio PCE credential — this app authenticates with a PCE API key over HTTP Basic auth. ' +
  'Create an API key in the PCE (Settings > API Keys, or a Personal API Key) with the "labels" scope, ' +
  'store its key (e.g. api_145a5c788e2ba897c) as the credential username and its secret as the API key ' +
  'secret / password, and set the PCE host, port and organization ID in the app\'s settings.'

/** `Authorization: Basic ...` header from an Illumio API key + secret pair. */
export function basicAuthHeader(cred: IllumioCredential): Record<string, string> {
  const encoded = Buffer.from(`${cred.key}:${cred.secret}`, 'utf8').toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

export interface IllumioResponse {
  status: number
  ok: boolean
  body: string
}

/**
 * One HTTPS request against the PCE. Uses node:https directly (not the global
 * fetch) so the `verify_tls` setting can control certificate trust per request;
 * self-signed / internal-CA certs are tolerated unless `verifyTls` is true.
 */
export function illumioRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<IllumioResponse> {
  const u = new URL(url)
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || DEFAULT_ILLUMIO_PORT,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        rejectUnauthorized: init.verifyTls === true,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          const status = res.statusCode ?? 0
          resolve({ status, ok: status >= 200 && status < 300, body: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${u.host}`)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

export async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<T> {
  const res = await illumioRequest(url, { headers, ...opts })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as T
}

export async function sendJson<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  opts: { timeoutMs?: number; verifyTls?: boolean } = {},
): Promise<T> {
  const res = await illumioRequest(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  })
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return (res.body ? JSON.parse(res.body) : {}) as T
}
