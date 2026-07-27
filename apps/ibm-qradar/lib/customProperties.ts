// =============================================================================
// Shared engine for QRadar custom properties (regex property + its expressions).
//
// A usable custom property is one regex_property (identity = unique name) plus
// one or more property_expressions (the actual regex per log source type). The
// event and flow variants are identical apart from the base path
// (event_sources vs flow_sources), so both config types are thin wrappers over
// this engine, parameterised by `base`.
//
// Reconcile: upsert the parent by name (store id + identifier), then nested-
// child reconcile of expressions keyed on log_source_type_id; reconcile only
// deletes parents / expressions THIS app created. Deletes may be async (202).
// =============================================================================

import type {
  CanvasSnapshot,
  DeployContext,
  DeployResult,
  DriftContext,
  DriftResult,
  HealthCheckContext,
  HealthCheckResult,
  PipelineContext,
  RollbackContext,
  RollbackResult,
  ValidationResult,
} from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from './qradar'
import { indexByLowerName, listLogSourceTypes } from './lookups'

export type PropertyBase = 'event_sources' | 'flow_sources'

export const PROPERTY_TYPES = ['string', 'numeric', 'ip', 'port', 'time'] as const

export interface ExpressionSpec {
  /** the log source type NAME, resolved to log_source_type_id in deploy. */
  logSourceType: string
  regex: string
  captureGroup: number
  enabled: boolean
}

export interface CustomPropertySpec {
  itemId?: string
  name: string
  propertyType: string
  description: string
  useForRuleEngine: boolean
  datetimeFormat: string
  locale: string
  expressionsRaw: string
}

export interface LiveRegexProperty {
  id?: number
  identifier?: string
  name?: string
  property_type?: string
  description?: string
  use_for_rule_engine?: boolean
  datetime_format?: string
  locale?: string
}

export interface LivePropertyExpression {
  id?: number
  identifier?: string
  regex_property_identifier?: string
  log_source_type_id?: number
  regex?: string
  capture_group?: number
  enabled?: boolean
}

export interface ParentState {
  name: string
  property_type: string
  description: string
  use_for_rule_engine: boolean
  datetime_format?: string
  locale?: string
}

export interface ExprState {
  regex: string
  capture_group: number
  enabled: boolean
}

export interface ExprEntry {
  logSourceTypeId: number
  existed: boolean
  id?: number
  prior?: ExprState
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  id?: number
  identifier?: string
  priorParent?: ParentState
  expressions: ExprEntry[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function regexPath(base: PropertyBase): string {
  return `/config/${base}/custom_properties/regex_properties`
}
function exprPath(base: PropertyBase): string {
  return `/config/${base}/custom_properties/property_expressions`
}

/** Parse the raw expressions blob (a JSON array of { logSourceType, regex, captureGroup?, enabled? }). */
export function parseExpressions(raw: string): { expressions: ExpressionSpec[]; error?: string } {
  const text = raw.trim()
  if (!text) return { expressions: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { expressions: [], error: 'expressions must be a JSON array of { "logSourceType", "regex" }' }
  }
  if (!Array.isArray(parsed)) return { expressions: [], error: 'expressions must be a JSON array' }
  const expressions: ExpressionSpec[] = []
  for (const e of parsed) {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
    const cg = o.captureGroup
    expressions.push({
      logSourceType: asString(o.logSourceType),
      regex: typeof o.regex === 'string' ? o.regex : '',
      captureGroup: typeof cg === 'number' ? cg : typeof cg === 'string' && /^\d+$/.test(cg.trim()) ? Number(cg.trim()) : 1,
      enabled: o.enabled !== false,
    })
  }
  return { expressions }
}

export function extractCustomPropertySpecs(canvas: CanvasSnapshot): CustomPropertySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const rawExpr =
      typeof f.expressions === 'string' ? f.expressions : f.expressions != null ? JSON.stringify(f.expressions) : ''
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      propertyType: (asString(f.propertyType) || 'string').toLowerCase(),
      description: asString(f.description),
      useForRuleEngine: f.useForRuleEngine === true,
      datetimeFormat: asString(f.datetimeFormat),
      locale: asString(f.locale),
      expressionsRaw: rawExpr,
    }
  })
}

export function validateCustomProperties(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCustomPropertySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate custom property "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(PROPERTY_TYPES as readonly string[]).includes(spec.propertyType)) {
      errors.push({ field: `${prefix}.propertyType`, message: `Property type must be one of: ${PROPERTY_TYPES.join(', ')}`, code: 'invalid_property_type' })
    }
    if (spec.propertyType === 'time' && (!spec.datetimeFormat || !spec.locale)) {
      errors.push({ field: `${prefix}.datetimeFormat`, message: 'A time property requires both a datetime format and a locale', code: 'time_requires_format' })
    }

    const { expressions, error } = parseExpressions(spec.expressionsRaw)
    if (error) {
      errors.push({ field: `${prefix}.expressions`, message: error, code: 'invalid_expressions' })
    } else {
      const seenTypes = new Set<string>()
      expressions.forEach((e, ei) => {
        if (!e.logSourceType) errors.push({ field: `${prefix}.expressions[${ei}].logSourceType`, message: 'Each expression needs a log source type name', code: 'required' })
        if (!e.regex) errors.push({ field: `${prefix}.expressions[${ei}].regex`, message: 'Each expression needs a regex', code: 'required' })
        const k = e.logSourceType.toLowerCase()
        if (e.logSourceType && seenTypes.has(k)) errors.push({ field: `${prefix}.expressions[${ei}].logSourceType`, message: `Duplicate log source type "${e.logSourceType}" for this property`, code: 'duplicate_log_source_type' })
        if (e.logSourceType) seenTypes.add(k)
      })
      if (expressions.length === 0) {
        warnings.push({ field: `${prefix}.expressions`, message: 'This property has no expressions, so it will not extract anything', code: 'empty_expressions' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function parentBody(spec: CustomPropertySpec): ParentState {
  const body: ParentState = {
    name: spec.name,
    property_type: spec.propertyType,
    description: spec.description,
    use_for_rule_engine: spec.useForRuleEngine,
  }
  if (spec.propertyType === 'time') {
    body.datetime_format = spec.datetimeFormat
    body.locale = spec.locale
  }
  return body
}

function parentStateOf(live: LiveRegexProperty): ParentState {
  const state: ParentState = {
    name: live.name ?? '',
    property_type: (live.property_type ?? '').toLowerCase(),
    description: live.description ?? '',
    use_for_rule_engine: live.use_for_rule_engine ?? false,
  }
  if (live.datetime_format !== undefined) state.datetime_format = live.datetime_format
  if (live.locale !== undefined) state.locale = live.locale
  return state
}

function parentDiffers(a: ParentState, b: ParentState): boolean {
  return (
    a.name !== b.name ||
    a.property_type !== b.property_type ||
    a.description !== b.description ||
    a.use_for_rule_engine !== b.use_for_rule_engine ||
    (a.datetime_format ?? '') !== (b.datetime_format ?? '') ||
    (a.locale ?? '') !== (b.locale ?? '')
  )
}

function exprStateOf(live: LivePropertyExpression): ExprState {
  return { regex: live.regex ?? '', capture_group: live.capture_group ?? 1, enabled: live.enabled ?? true }
}

async function listRegexProperties(client: QRadarClient, base: PropertyBase): Promise<LiveRegexProperty[]> {
  const res = await client.request('GET', regexPath(base), { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LiveRegexProperty[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

async function listExpressions(client: QRadarClient, base: PropertyBase): Promise<LivePropertyExpression[]> {
  const res = await client.request('GET', exprPath(base), { range: 'items=0-9999' })
  if (!res.ok) return []
  const parsed = parseJson<LivePropertyExpression[]>(res.body)
  return Array.isArray(parsed) ? parsed : []
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export function makeDeploy(base: PropertyBase, noun: string) {
  return async function deploy(ctx: DeployContext): Promise<DeployResult> {
    const settings = readQRadarSettings(ctx.settings)
    const cred = resolveQRadarCredential(ctx.credential, settings)
    if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
    const client = buildQRadarClient(cred, settings)

    const specs = extractCustomPropertySpecs(ctx.canvas).filter((s) => s.name)
    const prior = await loadPriorEntries(ctx)
    const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId as string, p]))
    const priorByName = new Map(prior.map((p) => [p.name.toLowerCase(), p]))

    const [types, liveProps, liveExprs] = await Promise.all([
      listLogSourceTypes(client),
      listRegexProperties(client, base),
      listExpressions(client, base),
    ])
    const typeByName = indexByLowerName(types)
    const propByName = new Map(liveProps.filter((p) => p.name).map((p) => [String(p.name).toLowerCase(), p]))

    const entries: RollbackEntry[] = []
    const failures: string[] = []

    for (const spec of specs) {
      const priorEntry = (spec.itemId && priorByItem.get(spec.itemId)) || priorByName.get(spec.name.toLowerCase())
      const existing = propByName.get(spec.name.toLowerCase())
      const desired = parentBody(spec)

      let parentId: number | undefined
      let identifier: string | undefined
      let existed: boolean
      let priorParent: ParentState | undefined

      if (existing && typeof existing.id === 'number') {
        parentId = existing.id
        identifier = existing.identifier
        existed = true
        priorParent = parentStateOf(existing)
        if (parentDiffers(priorParent, desired)) {
          const resp = await client.request('POST', `${regexPath(base)}/${existing.id}`, { body: desired })
          if (!resp.ok) {
            failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
            continue
          }
        }
      } else {
        const resp = await client.request('POST', regexPath(base), { body: desired })
        if (!resp.ok) {
          failures.push(`${spec.name}: ${qradarErrorMessage(resp)}`)
          continue
        }
        const created = parseJson<LiveRegexProperty>(resp.body)
        parentId = created?.id
        identifier = created?.identifier
        existed = false
      }

      if (!identifier) {
        failures.push(`${spec.name}: could not resolve the property identifier for its expressions`)
        entries.push({ itemId: spec.itemId, name: spec.name, existed, id: parentId, identifier, priorParent, expressions: [] })
        continue
      }

      const { expressions } = parseExpressions(spec.expressionsRaw)
      const priorExprById = new Map((priorEntry?.expressions ?? []).map((e) => [e.logSourceTypeId, e]))
      const liveForParent = liveExprs.filter((e) => e.regex_property_identifier === identifier)
      const liveByType = new Map(liveForParent.filter((e) => typeof e.log_source_type_id === 'number').map((e) => [e.log_source_type_id as number, e]))

      const exprEntries: ExprEntry[] = []
      const declaredTypeIds = new Set<number>()
      for (const e of expressions) {
        const typeId = typeByName.get(e.logSourceType.toLowerCase())
        if (typeId === undefined) {
          failures.push(`${spec.name}: unknown log source type "${e.logSourceType}"`)
          continue
        }
        declaredTypeIds.add(typeId)
        const liveExpr = liveByType.get(typeId)
        const exprBody = { regex_property_identifier: identifier, log_source_type_id: typeId, regex: e.regex, capture_group: e.captureGroup, enabled: e.enabled }
        if (liveExpr && typeof liveExpr.id === 'number') {
          const priorState = exprStateOf(liveExpr)
          if (priorState.regex !== e.regex || priorState.capture_group !== e.captureGroup || priorState.enabled !== e.enabled) {
            const resp = await client.request('POST', `${exprPath(base)}/${liveExpr.id}`, { body: exprBody })
            if (!resp.ok) {
              failures.push(`${spec.name} [${e.logSourceType}]: ${qradarErrorMessage(resp)}`)
              continue
            }
          }
          exprEntries.push({ logSourceTypeId: typeId, existed: true, id: liveExpr.id, prior: priorState })
        } else {
          const resp = await client.request('POST', exprPath(base), { body: exprBody })
          if (!resp.ok) {
            failures.push(`${spec.name} [${e.logSourceType}]: ${qradarErrorMessage(resp)}`)
            continue
          }
          const created = parseJson<LivePropertyExpression>(resp.body)
          exprEntries.push({ logSourceTypeId: typeId, existed: false, id: created?.id })
        }
      }

      // Reconcile-delete expressions THIS app created for this parent, no longer declared.
      for (const pe of priorEntry?.expressions ?? []) {
        if (!pe.existed && typeof pe.id === 'number' && !declaredTypeIds.has(pe.logSourceTypeId)) {
          const resp = await client.request('DELETE', `${exprPath(base)}/${pe.id}`)
          if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`${spec.name}: delete expression: ${qradarErrorMessage(resp)}`)
        }
      }
      void priorExprById

      entries.push({ itemId: spec.itemId, name: spec.name, existed, id: parentId, identifier, priorParent, expressions: exprEntries })
    }

    // Reconcile-delete parents THIS app created previously but no longer declares (and their app-created expressions).
    const declaredItemIds = new Set(specs.map((s) => s.itemId).filter(Boolean))
    const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
    for (const p of prior) {
      if (!p.existed && typeof p.id === 'number' && !(p.itemId && declaredItemIds.has(p.itemId)) && !declaredNames.has(p.name.toLowerCase())) {
        for (const pe of p.expressions) {
          if (!pe.existed && typeof pe.id === 'number') {
            const resp = await client.request('DELETE', `${exprPath(base)}/${pe.id}`)
            if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete expression of ${p.name}: ${qradarErrorMessage(resp)}`)
          }
        }
        const resp = await client.request('DELETE', `${regexPath(base)}/${p.id}`)
        if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${p.name}: ${qradarErrorMessage(resp)}`)
      }
    }

    if (failures.length) {
      return { success: false, message: `Some ${noun} failed: ${failures.join('; ')}`, rollbackData: { entries } }
    }
    return { success: true, message: `Deployed ${entries.length} ${noun}`, rollbackData: { entries } }
  }
}

export function makeRollback(base: PropertyBase, noun: string) {
  return async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
    const settings = readQRadarSettings(ctx.settings)
    const cred = resolveQRadarCredential(ctx.credential, settings)
    if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
    const client = buildQRadarClient(cred, settings)

    const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
    const entries = Array.isArray(data?.entries) ? data.entries : []
    const failures: string[] = []
    let restored = 0
    let deleted = 0

    for (const e of entries) {
      // Children first.
      for (const pe of e.expressions) {
        if (typeof pe.id !== 'number') continue
        if (!pe.existed) {
          const resp = await client.request('DELETE', `${exprPath(base)}/${pe.id}`)
          if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete expression: ${qradarErrorMessage(resp)}`)
          else deleted++
        } else if (pe.prior && e.identifier) {
          const body = { regex_property_identifier: e.identifier, log_source_type_id: pe.logSourceTypeId, regex: pe.prior.regex, capture_group: pe.prior.capture_group, enabled: pe.prior.enabled }
          const resp = await client.request('POST', `${exprPath(base)}/${pe.id}`, { body })
          if (!resp.ok) failures.push(`restore expression: ${qradarErrorMessage(resp)}`)
          else restored++
        }
      }
      if (typeof e.id !== 'number') continue
      if (!e.existed) {
        const resp = await client.request('DELETE', `${regexPath(base)}/${e.id}`)
        if (!resp.ok && resp.status !== 202 && resp.status !== 404) failures.push(`delete ${e.name}: ${qradarErrorMessage(resp)}`)
        else deleted++
      } else if (e.priorParent) {
        const resp = await client.request('POST', `${regexPath(base)}/${e.id}`, { body: e.priorParent })
        if (!resp.ok) failures.push(`restore ${e.name}: ${qradarErrorMessage(resp)}`)
        else restored++
      }
    }

    if (failures.length) {
      return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
    }
    return { success: true, message: `Rolled back ${noun}: ${deleted} deleted, ${restored} restored` }
  }
}

export function makeDriftDetect(base: PropertyBase) {
  return async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
    const settings = readQRadarSettings(ctx.settings)
    const cred = resolveQRadarCredential(ctx.credential, settings)
    if (!cred) return { hasDrift: false, diffs: [] }
    const client = buildQRadarClient(cred, settings)

    const specs = extractCustomPropertySpecs(ctx.deployedConfig).filter((s) => s.name)
    const live = await listRegexProperties(client, base)
    const byName = new Map(live.filter((p) => p.name).map((p) => [String(p.name).toLowerCase(), p]))

    const diffs: DriftResult['diffs'] = []
    for (const spec of specs) {
      const prop = byName.get(spec.name.toLowerCase())
      if (!prop) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if ((prop.property_type ?? '').toLowerCase() !== spec.propertyType) {
        diffs.push({ field: `${spec.name}.propertyType`, expected: spec.propertyType, actual: (prop.property_type ?? '').toLowerCase(), severity: 'warning' })
      }
      if ((prop.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: prop.description ?? '', severity: 'warning' })
      }
    }

    return { hasDrift: diffs.length > 0, diffs }
  }
}

export function makeHealthCheck(base: PropertyBase, name: string) {
  return async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    const checks: HealthCheckResult['checks'] = []
    const settings = readQRadarSettings(ctx.settings)
    const cred = resolveQRadarCredential(ctx.credential, settings)

    if (!cred) {
      checks.push({ name: 'credential', passed: false, message: 'No usable IBM QRadar credential / console host configured' })
      return { healthy: false, score: 0, checks }
    }

    const client = buildQRadarClient(cred, settings)
    const start = Date.now()
    const resp = await client.request('GET', regexPath(base), { range: 'items=0-0' })
    const latencyMs = Date.now() - start
    const passed = resp.ok

    checks.push({
      name,
      passed,
      message: passed ? 'Reached the QRadar custom-properties endpoint' : `QRadar error: ${qradarErrorMessage(resp)}`,
      latencyMs,
    })

    return { healthy: passed, score: passed ? 100 : 0, checks }
  }
}
