// =============================================================================
// Splunk AppInspect client.
//
// Splunk Cloud does not allow arbitrary REST config writes. The ONLY supported
// route for a private app is:
//
//     build the .spl  ->  AppInspect vetting  ->  ACS install
//
// AppInspect is a SEPARATE service from ACS with its OWN credentials:
//
//   AppInspect  splunk.com account (username + password)  -> a short-lived JWT
//   ACS         the Splunk Cloud stack token (sc_admin)   -> the Bearer token
//
// The two tokens are never interchangeable. ACS install takes BOTH: the stack
// token authenticates the caller, the AppInspect JWT proves the package passed
// vetting (Victoria sends it in X-Splunk-Authorization, Classic as a form field).
//
// Endpoints (all documented by Splunk):
//   login   GET  https://api.splunk.com/2.0/rest/login/splunk    (HTTP Basic)
//   submit  POST https://appinspect.splunk.com/v1/app/validate   (multipart)
//   status  GET  https://appinspect.splunk.com/v1/app/validate/status/{id}
//   report  GET  https://appinspect.splunk.com/v1/app/report/{id}
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'
import { buildMultipartBody } from './multipart'
import type { SplunkCloudExperience } from './acs'

export const APPINSPECT_LOGIN_URL = 'https://api.splunk.com/2.0/rest/login/splunk'
export const APPINSPECT_BASE_URL = 'https://appinspect.splunk.com/v1/app'

/**
 * The vetting profile. `private_victoria` / `private_classic` run the Cloud
 * checks for a PRIVATE app — the profile ACS install requires. Submitting
 * without them vets the package as if it were headed for Splunkbase, and the
 * resulting report is not the one ACS honours.
 */
export const PRIVATE_TAG: Record<SplunkCloudExperience, string> = {
  victoria: 'private_victoria',
  classic: 'private_classic',
}

/** Terminal statuses of a validation request; anything else means keep polling. */
const TERMINAL_STATUSES = new Set(['SUCCESS', 'ERROR'])

// --- Credentials -------------------------------------------------------------

export interface AppInspectCredentials {
  username: string
  password: string
}

/**
 * AppInspect authenticates with a splunk.com (Splunkbase) ACCOUNT, not with the
 * stack token — so the credential must carry a username and password in ADDITION
 * to the ACS API token. Returns null when either half is missing; the deploy
 * handler turns that into a hard failure rather than skipping vetting, because
 * an unvetted package cannot be installed on Cloud at all.
 */
export function resolveAppInspectCredentials(
  credential: CredentialRef | null,
): AppInspectCredentials | null {
  const username = credential?.username?.trim() ?? ''
  const password = credential?.password ?? ''
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_APPINSPECT_CREDENTIALS_MESSAGE =
  'Splunk Cloud private-app install requires a splunk.com account for AppInspect vetting IN ADDITION to the ACS stack token. ' +
  'Add the splunk.com username and password to the credential (the ACS JWT stays in the "API token" field) — ' +
  'Splunk Cloud has no route to install an app that has not been vetted.'

// --- Report model ------------------------------------------------------------

export interface AppInspectSummary {
  error: number
  failure: number
  manual_check: number
  not_applicable: number
  skipped: number
  success: number
  warning: number
}

export interface AppInspectCheck {
  name?: string
  result?: string
  description?: string
  messages?: Array<{ message?: string; filename?: string; line?: number }>
}

export interface AppInspectReport {
  request_id?: string
  summary?: Partial<AppInspectSummary>
  reports?: Array<{
    app_name?: string
    groups?: Array<{ name?: string; checks?: AppInspectCheck[] }>
  }>
}

/** One check that blocks self-service install. */
export interface BlockingCheck {
  name: string
  result: 'failure' | 'error' | 'manual_check'
  message: string
}

export const EMPTY_SUMMARY: AppInspectSummary = {
  error: 0,
  failure: 0,
  manual_check: 0,
  not_applicable: 0,
  skipped: 0,
  success: 0,
  warning: 0,
}

function readSummary(report: AppInspectReport): AppInspectSummary {
  const raw = report.summary ?? {}
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    error: num(raw.error),
    failure: num(raw.failure),
    manual_check: num(raw.manual_check),
    not_applicable: num(raw.not_applicable),
    skipped: num(raw.skipped),
    success: num(raw.success),
    warning: num(raw.warning),
  }
}

/**
 * Walk reports[].groups[].checks[] and collect every check whose result blocks
 * install, so the user is told WHAT to fix rather than just that vetting failed.
 */
export function collectBlockingChecks(report: AppInspectReport): BlockingCheck[] {
  const blocking: BlockingCheck[] = []

  for (const entry of report.reports ?? []) {
    for (const group of entry.groups ?? []) {
      for (const check of group.checks ?? []) {
        const result = check.result
        if (result !== 'failure' && result !== 'error' && result !== 'manual_check') continue
        const messages = (check.messages ?? [])
          .map((m) => (typeof m?.message === 'string' ? m.message.trim() : ''))
          .filter((m) => m.length > 0)
        blocking.push({
          name: check.name ?? group.name ?? 'unnamed check',
          result,
          message: messages[0] ?? check.description?.trim() ?? 'no message provided',
        })
      }
    }
  }

  return blocking
}

export interface AppInspectGate {
  /** True only when the report clears every blocking category. */
  allowed: boolean
  summary: AppInspectSummary
  blocking: BlockingCheck[]
  /** Why install is blocked — empty when allowed. */
  reason: string
}

/**
 * THE GATE. Splunk Cloud accepts a private app only when the vetting report has
 * no failures, no errors AND no manual checks:
 *
 *     failure == 0 && error == 0 && manual_check == 0
 *
 * `manual_check > 0` is not a soft finding — it means a human at Splunk must
 * review the package, so SELF-SERVICE INSTALL IS IMPOSSIBLE and the user has to
 * open a Splunk Support case. Saying that plainly is the whole point of this
 * function: an install attempted anyway is rejected by ACS.
 */
export function evaluateGate(report: AppInspectReport): AppInspectGate {
  const summary = readSummary(report)
  const blocking = collectBlockingChecks(report)

  const allowed = summary.failure === 0 && summary.error === 0 && summary.manual_check === 0
  if (allowed) {
    return { allowed: true, summary, blocking, reason: '' }
  }

  const parts: string[] = []
  if (summary.failure > 0) parts.push(`${summary.failure} failure(s)`)
  if (summary.error > 0) parts.push(`${summary.error} error(s)`)
  if (summary.manual_check > 0) parts.push(`${summary.manual_check} manual check(s)`)

  let reason = `AppInspect vetting did not pass: ${parts.join(', ')}.`

  if (summary.manual_check > 0) {
    reason +=
      ' A manual check BLOCKS self-service install entirely — Splunk Cloud cannot install this app through ACS. ' +
      'Contact Splunk Support to have the package reviewed and installed for you.'
  }

  const detail = describeBlockingChecks(blocking)
  if (detail) reason += ` Findings: ${detail}`

  return { allowed: false, summary, blocking, reason }
}

/** One-line rendering of the blocking checks, capped so a message stays readable. */
export function describeBlockingChecks(blocking: BlockingCheck[], limit = 8): string {
  if (blocking.length === 0) return ''
  const shown = blocking
    .slice(0, limit)
    .map((check) => `[${check.result}] ${check.name}: ${check.message}`)
  const more = blocking.length > limit ? ` (+${blocking.length - limit} more)` : ''
  return shown.join('; ') + more
}

// --- HTTP --------------------------------------------------------------------

export interface AppInspectOptions {
  /** Per-request timeout. */
  timeoutMs: number
  /** Overall budget for the PROCESSING poll loop. */
  maxWaitMs: number
  /** Overridable for tests; defaults to the public service. */
  loginUrl?: string
  baseUrl?: string
}

export const DEFAULT_APPINSPECT_OPTIONS: Pick<AppInspectOptions, 'timeoutMs' | 'maxWaitMs'> = {
  timeoutMs: 120_000,
  maxWaitMs: 900_000,
}

interface RawResponse {
  status: number
  ok: boolean
  body: string
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<RawResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    return { status: res.status, ok: res.ok, body: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

function parse<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** Truncate a service error body so a failure message stays legible. */
function briefly(body: string, limit = 300): string {
  const text = body.trim().replace(/\s+/g, ' ')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exchange a splunk.com username/password for an AppInspect JWT.
 * HTTP Basic — the response is `{ data: { token } }`.
 */
export async function appInspectLogin(
  credentials: AppInspectCredentials,
  options: AppInspectOptions,
): Promise<string> {
  const basic = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString(
    'base64',
  )
  const res = await request(
    options.loginUrl ?? APPINSPECT_LOGIN_URL,
    { method: 'GET', headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' } },
    options.timeoutMs,
  )

  if (res.status === 401) {
    throw new Error(
      'AppInspect login failed (401) — the splunk.com username/password on the credential were rejected. ' +
        'These are the Splunk.com account credentials, not the Splunk Cloud stack login.',
    )
  }
  if (!res.ok) {
    throw new Error(`AppInspect login failed (HTTP ${res.status}): ${briefly(res.body)}`)
  }

  const token = parse<{ data?: { token?: string } }>(res.body)?.data?.token
  if (!token) {
    throw new Error('AppInspect login returned no token — the response did not contain data.token')
  }
  return token
}

/**
 * Submit the package for vetting. Returns the request id.
 *
 * `included_tags` selects the private-app profile for the target experience —
 * `private_victoria` or `private_classic`.
 */
export async function submitForVetting(
  token: string,
  pkg: { fileName: string; bytes: Buffer },
  experience: SplunkCloudExperience,
  options: AppInspectOptions,
): Promise<string> {
  const multipart = buildMultipartBody([
    {
      name: 'app_package',
      fileName: pkg.fileName,
      contentType: 'application/octet-stream',
      bytes: pkg.bytes,
    },
    { name: 'included_tags', value: PRIVATE_TAG[experience] },
  ])

  const res = await request(
    `${options.baseUrl ?? APPINSPECT_BASE_URL}/validate`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': multipart.contentType,
        Accept: 'application/json',
      },
      body: multipart.body as unknown as BodyInit,
    },
    options.timeoutMs,
  )

  if (!res.ok) {
    throw new Error(`AppInspect submission failed (HTTP ${res.status}): ${briefly(res.body)}`)
  }

  const requestId = parse<{ request_id?: string }>(res.body)?.request_id
  if (!requestId) {
    throw new Error('AppInspect submission returned no request_id')
  }
  return requestId
}

/**
 * Poll the validation status until it leaves PROCESSING.
 * Backs off from 5s to 30s and gives up after `maxWaitMs`.
 */
export async function waitForVetting(
  token: string,
  requestId: string,
  options: AppInspectOptions,
): Promise<string> {
  const deadline = Date.now() + options.maxWaitMs
  let intervalMs = 5_000

  for (;;) {
    const res = await request(
      `${options.baseUrl ?? APPINSPECT_BASE_URL}/validate/status/${encodeURIComponent(requestId)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      },
      options.timeoutMs,
    )

    if (!res.ok) {
      throw new Error(`AppInspect status check failed (HTTP ${res.status}): ${briefly(res.body)}`)
    }

    const status = parse<{ status?: string }>(res.body)?.status ?? 'UNKNOWN'
    if (TERMINAL_STATUSES.has(status)) return status

    if (Date.now() >= deadline) {
      throw new Error(
        `AppInspect vetting did not finish within ${Math.round(options.maxWaitMs / 1000)}s ` +
          `(last status "${status}", request ${requestId})`,
      )
    }

    await sleep(intervalMs)
    intervalMs = Math.min(intervalMs * 1.5, 30_000)
  }
}

/** Fetch the JSON report for a finished validation request. */
export async function fetchReport(
  token: string,
  requestId: string,
  options: AppInspectOptions,
): Promise<AppInspectReport> {
  const res = await request(
    `${options.baseUrl ?? APPINSPECT_BASE_URL}/report/${encodeURIComponent(requestId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    },
    options.timeoutMs,
  )

  if (!res.ok) {
    throw new Error(`AppInspect report fetch failed (HTTP ${res.status}): ${briefly(res.body)}`)
  }

  const report = parse<AppInspectReport>(res.body)
  if (!report) {
    throw new Error('AppInspect report was not valid JSON')
  }
  return report
}

export interface VettingResult extends AppInspectGate {
  requestId: string
  /** Terminal status of the validation request (SUCCESS | ERROR). */
  status: string
}

/**
 * Vet one package end to end: submit -> poll -> report -> gate.
 *
 * The caller logs in ONCE (a JWT is good for the whole deploy) and passes the
 * token in, because that same token must also travel to ACS with the install.
 * A non-passing gate is returned, not thrown — deploy decides how loudly to
 * fail, and a blocked report still carries the findings the user must act on.
 */
export async function vetPackage(
  token: string,
  pkg: { fileName: string; bytes: Buffer },
  experience: SplunkCloudExperience,
  options: AppInspectOptions,
): Promise<VettingResult> {
  const requestId = await submitForVetting(token, pkg, experience, options)
  const status = await waitForVetting(token, requestId, options)
  const report = await fetchReport(token, requestId, options)
  const gate = evaluateGate(report)

  // A terminal ERROR means AppInspect itself could not complete the run — the
  // summary may look clean, so the gate must not be allowed to pass on it.
  if (status === 'ERROR' && gate.allowed) {
    return {
      ...gate,
      allowed: false,
      reason: `AppInspect finished with status ERROR (request ${requestId}) — the package could not be vetted.`,
      requestId,
      status,
    }
  }

  return { ...gate, requestId, status }
}
