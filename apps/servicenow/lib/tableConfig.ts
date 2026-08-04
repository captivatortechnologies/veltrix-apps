// =============================================================================
// Generic single-table config engine for ServiceNow config types.
//
// A config type that manages one sys_* table as code (upsert-by-natural-key)
// describes itself with a TableConfigSpec and delegates deploy / rollback /
// drift / health / status to the functions here. This keeps the query-then-
// PATCH/POST pattern (from the Business Rules config type) in one audited place
// so every table config type behaves identically.
//
// Applied over the Table API (lib/servicenowApi.ts):
//   lookup: GET   /table/{table}?sysparm_query=<identity>   (natural-key match)
//   create: POST  /table/{table}                            (new record)
//   update: PATCH /table/{table}/{sys_id}                   (partial, managed cols)
//   delete: DELETE/table/{table}/{sys_id}                   (rollback of a create)
// =============================================================================

import type {
  DeployContext,
  DeployResult,
  RollbackContext,
  RollbackResult,
  DriftContext,
  DriftResult,
  DriftDiff,
  HealthCheckContext,
  HealthCheckResult,
  HealthCheck,
  PipelineContext,
  ConfigStatus,
  ComponentConfigStatus,
} from '@veltrixsecops/app-sdk'
import {
  buildServiceNowClient,
  resultList,
  resultObject,
  serviceNowErrorMessage,
} from './servicenowApi'
import {
  normalizeBool,
  normalizeInt,
  encodedQuery,
  findByIdentity,
  managedSnapshot,
  csvSetEqual,
  normalizeCsvSet,
} from './tableRecords'

/** Declarative description of one upsert-by-natural-key ServiceNow table config type. */
export interface TableConfigSpec {
  /** The sys_* table name (e.g. sys_ui_policy). */
  table: string
  /** Managed columns, in a stable order — the field allow-list for reads, drift and snapshots. */
  managedColumns: readonly string[]
  /** Columns forming the natural-key identity (e.g. ['name'] or ['short_description','table']). */
  identityColumns: readonly string[]
  /** Columns coerced as ServiceNow booleans (for drift + payloads). */
  boolColumns?: readonly string[]
  /** Integer columns → default value (for drift comparison + coercion). */
  intColumns?: Readonly<Record<string, number>>
  /**
   * Comma-separated "list" columns (e.g. recipient_users, assignable_by) whose
   * drift is compared as an unordered set rather than an exact string — avoids
   * false-positive drift when ServiceNow (or an operator) reorders the list.
   */
  setColumns?: readonly string[]
  /** Columns whose drift is reported as `critical` (all others are `warning`). */
  criticalColumns?: readonly string[]
  /** Map a canvas item's fields → the identity column VALUES (trimmed). */
  identityOf(fields: Record<string, unknown>): Record<string, string>
  /** Build the full write body (managed columns only) from a canvas item's fields. */
  buildBody(fields: Record<string, unknown>): Record<string, unknown>
  /** Human-readable label for an item, used in messages and drift fields. */
  labelOf(fields: Record<string, unknown>): string
}

/** One entry recorded per applied item so rollback can restore or delete it. */
interface PreviousEntry {
  identity: Record<string, string>
  sysId: string | null
  record: Record<string, unknown> | null
}

function identityPairs(spec: TableConfigSpec, fields: Record<string, unknown>): Array<[string, string]> {
  const id = spec.identityOf(fields)
  return spec.identityColumns.map((col) => [col, (id[col] ?? '').trim()])
}

function hasIdentity(spec: TableConfigSpec, fields: Record<string, unknown>): boolean {
  const id = spec.identityOf(fields)
  return spec.identityColumns.every((col) => (id[col] ?? '').trim() !== '')
}

/** Deploy: upsert every canvas item into `spec.table` by its natural key. */
export async function deployTable(ctx: DeployContext, spec: TableConfigSpec): Promise<DeployResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const fields = item.fields
      if (!hasIdentity(spec, fields)) continue

      const pairs = identityPairs(spec, fields)
      const identity = Object.fromEntries(pairs)
      const label = spec.labelOf(fields)

      const lookup = await client.list(spec.table, {
        query: encodedQuery(pairs),
        fields: ['sys_id', ...spec.managedColumns],
        limit: 1,
      })
      if (!lookup.ok) {
        throw new Error(`Lookup of "${label}" failed (HTTP ${lookup.status}): ${serviceNowErrorMessage(lookup)}`)
      }
      const existing = findByIdentity(resultList(lookup), pairs)
      const body = spec.buildBody(fields)

      if (existing && typeof existing.sys_id === 'string' && existing.sys_id) {
        const res = await client.update(spec.table, existing.sys_id, body)
        if (!res.ok) {
          throw new Error(`Update of "${label}" failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        previous.push({ identity, sysId: existing.sys_id, record: managedSnapshot(existing, spec.managedColumns) })
      } else {
        const res = await client.create(spec.table, body)
        if (!res.ok) {
          throw new Error(`Create of "${label}" failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        const created = resultObject(res)
        const newId = created && typeof created.sys_id === 'string' ? created.sys_id : null
        previous.push({ identity, sysId: newId, record: null })
      }
      applied.push(label)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ${spec.table} record(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { table: spec.table, previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Deploy to ${spec.table} failed after ${applied.length} record(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { table: spec.table, previous },
    }
  }
}

/** Rollback: restore updated records and delete created ones from deploy's rollbackData. */
export async function rollbackTable(ctx: RollbackContext, spec: TableConfigSpec): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: PreviousEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { sysId, record } of previous) {
      if (!sysId) {
        skipped++
        continue
      }
      if (record) {
        const res = await client.update(spec.table, sysId, record)
        if (!res.ok) {
          throw new Error(`Restore of ${sysId} failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        restored++
      } else {
        const res = await client.remove(spec.table, sysId)
        // 404 = already gone; treat as deleted rather than an error.
        if (!res.ok && res.status !== 404) {
          throw new Error(`Delete of ${sysId} failed (HTTP ${res.status}): ${serviceNowErrorMessage(res)}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back ${spec.table}: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

/** Drift: compare each declared item's managed fields against the live record. Read-only, best-effort. */
export async function driftTable(ctx: DriftContext, spec: TableConfigSpec): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const boolCols = new Set(spec.boolColumns ?? [])
  const intCols = spec.intColumns ?? {}
  const setCols = new Set(spec.setColumns ?? [])
  const criticalCols = new Set(spec.criticalColumns ?? [])
  const identityCols = new Set(spec.identityColumns)

  for (const item of items) {
    const fields = item.fields
    if (!hasIdentity(spec, fields)) continue
    const pairs = identityPairs(spec, fields)

    let live: Record<string, unknown> | null
    try {
      const res = await client.list(spec.table, {
        query: encodedQuery(pairs),
        fields: ['sys_id', ...spec.managedColumns],
        limit: 1,
      })
      if (!res.ok) continue
      live = findByIdentity(resultList(res), pairs)
    } catch {
      continue // best-effort
    }
    if (!live) continue

    const label = spec.labelOf(fields)
    const expected = spec.buildBody(fields)

    for (const col of spec.managedColumns) {
      if (identityCols.has(col)) continue // identity always matches the query
      const exp = expected[col]
      const act = live[col]

      let mismatch: boolean
      if (boolCols.has(col)) {
        mismatch = normalizeBool(exp) !== normalizeBool(act)
      } else if (col in intCols) {
        mismatch = normalizeInt(exp, intCols[col]) !== normalizeInt(act, intCols[col])
      } else if (setCols.has(col)) {
        mismatch = !csvSetEqual(exp, act)
      } else {
        mismatch = String(exp ?? '') !== String(act ?? '')
      }

      if (mismatch) {
        diffs.push({
          field: `${label}.${col}`,
          expected: boolCols.has(col)
            ? normalizeBool(exp)
            : col in intCols
              ? normalizeInt(exp, intCols[col])
              : setCols.has(col)
                ? normalizeCsvSet(exp)
                : exp,
          actual: boolCols.has(col)
            ? normalizeBool(act)
            : col in intCols
              ? normalizeInt(act, intCols[col])
              : setCols.has(col)
                ? normalizeCsvSet(act)
                : (act ?? ''),
          severity: criticalCols.has(col) ? 'critical' : 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Health: a read of `spec.table` with the configured credential (reachability + read access). */
export async function healthTable(ctx: HealthCheckContext, spec: TableConfigSpec): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client, instanceUrl } = built

  const started = Date.now()
  try {
    const res = await client.list(spec.table, { limit: 1, fields: ['sys_id'] })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      checks.push({ name: 'servicenow_auth', passed: false, message: `ServiceNow rejected the credential (HTTP ${res.status}).`, latencyMs })
    } else if (res.ok) {
      checks.push({ name: 'servicenow_reachable', passed: true, message: `ServiceNow reachable at ${instanceUrl} — read ${spec.table} (HTTP ${res.status}).`, latencyMs })
    } else {
      checks.push({ name: 'servicenow_reachable', passed: false, message: `ServiceNow returned HTTP ${res.status}: ${serviceNowErrorMessage(res)}`, latencyMs })
    }
  } catch (error) {
    checks.push({
      name: 'servicenow_reachable',
      passed: false,
      message: `ServiceNow unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}

/** Status: deployment status for a config, from platform records (shared across table config types). */
export async function configStatus(ctx: PipelineContext, componentTypes: string[]): Promise<ConfigStatus> {
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
    healthy: latest.healthScore ? latest.healthScore >= 80 : undefined,
    healthScore: latest.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || latest.startedAt,
    componentStatuses,
  }
}
