// =============================================================================
// Generic "flat record" engine — shared by every Splunk SOAR config type whose
// live object is a simple named record reachable at a single /rest/<type>
// collection: Severities, Container Statuses, CEF Custom Fields and Automation
// Accounts all share this identical CRUD lifecycle (see lib/soarApi.ts for the
// cited REST convention):
//   list   : GET  /rest/<type>?page_size=0      → { data: [...] }
//   create : POST /rest/<type>                  body = the record
//   update : POST /rest/<type>/<id>              body = the record (full replace)
//   delete : DELETE /rest/<type>/<id>            requires a USER-authenticated
//            credential — see lib/soarApi.ts DELETE_AUTH_HINT
//
// Roles (permission array is order-sensitive), Assets (write-only
// `configuration`) and Custom Lists (a differently-shaped update: full content
// replace, not a record body) are bespoke — each has its own deploy/drift/
// rollback built on the same lib/soarApi.ts primitives, since their live shape
// doesn't fit this generic engine cleanly. Container Labels has no per-item
// update at all (add/remove only) and is bespoke too.
// =============================================================================

import type {
  DeployContext,
  DeployResult,
  RollbackContext,
  RollbackResult,
  DriftContext,
  DriftResult,
  DriftDiff,
  PipelineContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  HealthCheckContext,
  HealthCheckResult,
  HealthCheck,
  ConfigStatus,
  ComponentConfigStatus,
} from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll, sendJson, findByField, DELETE_AUTH_HINT, type SoarRecord } from './soarApi'
import { canonicalJson, pickKeys } from './soarCommon'

/** Everything the shared handlers need to talk to one SOAR record collection. */
export interface RecordDescriptor {
  /** REST resource path segment, e.g. "severity", "container_status", "cef", "ph_user". */
  resource: string
  /** Singular, lower-case noun for messages, e.g. "severity". */
  kind: string
  /** Title-case noun for messages, e.g. "Severity". */
  Kind: string
  /** The record's identity field on the wire. Default "name" — ph_user uses "username". */
  identityKey?: string
  /**
   * Extra query-string params appended to the LIST read, e.g. ph_user's
   * `&include_automation=true` (automation-type users are excluded from the
   * default list). Leading "&", no leading "?".
   */
  listParams?: string
}

/** The outcome of turning one canvas item's fields into a request body. */
export interface RecordSpec {
  /** '' when the item has no identity yet — the caller should skip/report it. */
  id: string
  /** The full request body, or null when `error` is set. */
  body: Record<string, unknown> | null
  error: string | null
}

/** Per config type: build the record's identity + REST body from its canvas fields. */
export type BuildRecord = (fields: Record<string, unknown>, settings: Record<string, unknown>) => RecordSpec

// --- validate (static) --------------------------------------------------------

/**
 * Validate record items using the type's own `build` callback: an item whose
 * callback reports an error is invalid; a duplicate identity is a warning
 * (last one wins, matching the deploy upsert order).
 */
export function validateRecords(ctx: PipelineContext, desc: RecordDescriptor, build: BuildRecord): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const settings = ctx.settings ?? {}

  if (items.length === 0) {
    errors.push({ field: 'items', message: `Add at least one ${desc.kind}.`, code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = build(item.fields, settings)
    if (!spec.id) {
      errors.push({ field: `items[${i}].id`, message: `${desc.Kind} identity is required.`, code: 'EMPTY_ID' })
      return
    }
    if (spec.error) {
      errors.push({ field: `items[${i}]`, message: spec.error, code: 'INVALID' })
      return
    }
    const key = spec.id.toLowerCase()
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].id`,
        message: `${desc.Kind} "${spec.id}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_ID',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

// --- deploy --------------------------------------------------------------------

/**
 * Deploy records over the REST API, upserting by identity: create (POST) when
 * unseen, otherwise update (POST /<numeric id>). rollbackData records the prior
 * body (null when it did not exist) plus the record's numeric id — a prior body
 * restores via POST /<id>; a newly-created record (no prior body) is removed on
 * rollback via DELETE /<id>.
 */
export async function deployRecords(ctx: DeployContext, desc: RecordDescriptor, build: BuildRecord): Promise<DeployResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const identityKey = desc.identityKey ?? 'name'

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} deployment` }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ id: string; recordId: number | string | null; record: SoarRecord | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll<SoarRecord>(base, headers, desc.resource, desc.listParams ?? '')

    for (const item of items) {
      const spec = build(item.fields, settings ?? {})
      if (!spec.id) continue
      if (spec.error || !spec.body) {
        return {
          success: false,
          message: `${desc.Kind} ${spec.id}: ${spec.error ?? 'invalid configuration'}`,
          artifacts: { applied },
          rollbackData: { previous },
        }
      }

      const existing = findByField(live, identityKey, spec.id)
      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/rest/${desc.resource}/${encodeURIComponent(String(existing.id))}`, headers, spec.body)
        previous.push({ id: spec.id, recordId: existing.id, record: existing })
      } else {
        const created = await sendJson<{ id?: number | string }>('POST', `${base}/rest/${desc.resource}`, headers, spec.body)
        previous.push({ id: spec.id, recordId: created?.id ?? null, record: null })
      }
      applied.push(spec.id)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ${desc.kind}(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `${desc.Kind} deploy failed after ${applied.length} ${desc.kind}(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}

// --- rollback --------------------------------------------------------------------

/**
 * Undo a records deploy from rollbackData.previous: a newly-created record
 * (prior null) is removed via DELETE; a record that existed before the deploy
 * is restored via POST /<id> with its captured prior body. DELETE requires a
 * user-authenticated credential (see lib/soarApi.ts DELETE_AUTH_HINT) — a
 * failure there is surfaced with that hint rather than silently skipped.
 */
export async function rollbackRecords(ctx: RollbackContext, desc: RecordDescriptor): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ id: string; recordId: number | string | null; record: SoarRecord | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} rollback` }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let removed = 0
  try {
    for (const { recordId, record } of previous) {
      if (recordId == null) continue // never learned an id — nothing addressable to undo
      const url = `${base}/rest/${desc.resource}/${encodeURIComponent(String(recordId))}`
      if (record) {
        await sendJson('POST', url, headers, record)
        restored++
      } else {
        await sendJson('DELETE', url, headers)
        removed++
      }
    }
    return { success: true, message: `Rolled back ${desc.kind}s: ${restored} restored, ${removed} removed.` }
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, message: `Rollback failed: ${msg} — ${DELETE_AUTH_HINT}` }
  }
}

// --- drift --------------------------------------------------------------------

/**
 * Drift for records: compare every declared field against the live record.
 * Best-effort — an unreadable collection is skipped rather than raising false
 * drift. `ignoreKeys` (default none) excludes write-only fields the API never
 * echoes back from the comparison.
 */
export async function driftRecords(
  ctx: DriftContext,
  desc: RecordDescriptor,
  build: BuildRecord,
  ignoreKeys: string[] = [],
): Promise<DriftResult> {
  const { component, credential, connectivity, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []
  const identityKey = desc.identityKey ?? 'name'

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let live: SoarRecord[]
  try {
    live = await listAll<SoarRecord>(base, headers, desc.resource, desc.listParams ?? '')
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read the collection, no drift asserted
  }

  for (const item of items) {
    const spec = build(item.fields, settings ?? {})
    if (!spec.id || spec.error || !spec.body) continue

    const match = findByField(live, identityKey, spec.id)
    if (!match) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const keys = Object.keys(spec.body).filter((k) => !ignoreKeys.includes(k))
    const expected = pickKeys(spec.body, keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: spec.id, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

// --- shared health/status (every SOAR config type targets the same instance) --

/**
 * Health = the SOAR REST API answers with the configured credential
 * (GET /rest/version). Identical for every config type in this app — they all
 * deploy onto the same `soar-instance` component.
 */
export async function soarHealthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await fetch(`${base}/rest/version`, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) })
    checks.push({
      name: 'soar_reachable',
      passed: res.ok,
      message: res.ok ? 'Splunk SOAR instance is reachable' : `SOAR /rest/version returned ${res.status}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'soar_reachable',
      passed: false,
      message: `SOAR unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: Math.round((passed / checks.length) * 100), checks }
}

/** Deployment status for a SOAR configuration, from platform records. */
export async function soarGetStatus(ctx: PipelineContext, componentTypes: string[] = ['soar-instance']): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: componentTypes })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || '',
    healthy: latest.healthScore != null ? latest.healthScore >= 80 : undefined,
    healthScore: latest.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || latest.startedAt,
    componentStatuses,
  }
}
