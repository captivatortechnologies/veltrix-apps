// =============================================================================
// Cribl "system entity" engine — shared by the Sources (system/inputs) and
// Destinations (system/outputs) config types, which have an IDENTICAL REST shape
// and CRUD lifecycle and differ only by their resource path and labels.
//
// Cribl models an input / output as ONE FLAT object whose type-specific settings
// are spread onto the object alongside `id` and `type`:
//   { id: "in_http", type: "http", host: "0.0.0.0", port: 10080, ... }
// so the config authoring surface splits that into three fields — id, type and a
// `conf` JSON block (everything else) — and the deploy body is rebuilt as
// { id, type, ...conf }. Verify field flattening against a live Cribl.
//
// Endpoints (group-scoped; a blank group targets a single-instance deployment):
//   list   : GET   /api/v1/m/<group>/system/{inputs|outputs}
//   create : POST  /api/v1/m/<group>/system/{inputs|outputs}          { id, type, ...conf }
//   update : PATCH /api/v1/m/<group>/system/{inputs|outputs}/<id>     { id, type, ...conf }
//   delete : DELETE/api/v1/m/<group>/system/{inputs|outputs}/<id>
// PATCH on the management plane expects the full resource representation. Verify
// against a live Cribl.
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
} from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, getJson, sendJson, groupResourcePath, apiRoot } from './criblApi'
import {
  CRIBL_ID_RE,
  resolveWorkerGroup,
  itemsFromList,
  findById,
  canonicalJson,
  pickKeys,
  parseJsonObject,
} from './criblCommon'

/** One Cribl input / output object as returned by the REST API. */
export interface SystemEntity {
  id?: string
  type?: string
  [key: string]: unknown
}

/**
 * Everything the shared handlers need to talk to one Cribl system collection.
 * Sources and Destinations each provide one of these.
 */
export interface EntityDescriptor {
  /** Resource path segment, e.g. "system/inputs" / "system/outputs" / "notification-targets". */
  resource: string
  /** Singular, lower-case noun for messages, e.g. "source". */
  kind: string
  /** Title-case noun for messages, e.g. "Source". */
  Kind: string
  /**
   * Default true. Sources/Destinations live under `/api/v1/m/<group>/<resource>`.
   * Notification Targets are a single global collection at `/api/v1/<resource>`
   * with no Worker Group scoping at all — set false for those.
   */
  groupScoped?: boolean
}

/** The resource path for a descriptor: group-scoped, or a flat `apiRoot` path when it isn't. */
function resourcePathFor(base: string, desc: EntityDescriptor, group: string): string {
  return desc.groupScoped === false ? `${apiRoot(base)}/${desc.resource}` : groupResourcePath(base, group, desc.resource)
}

/** Build the REST body for an entity: identity + type + the flattened conf. */
export function buildEntityBody(id: string, type: string, conf: Record<string, unknown>): SystemEntity {
  return { id: id.trim(), type: type.trim(), ...conf }
}

/** The keys we own on an entity — used to compare only what we declare (drift). */
function declaredKeys(type: string, conf: Record<string, unknown>): string[] {
  return ['type', ...Object.keys({ ...conf, type })].filter((k, i, a) => a.indexOf(k) === i)
}

async function listEntities(
  base: string,
  headers: Record<string, string>,
  group: string,
  desc: EntityDescriptor,
): Promise<SystemEntity[]> {
  try {
    return itemsFromList<SystemEntity>(await getJson<unknown>(resourcePathFor(base, desc, group), headers))
  } catch {
    return []
  }
}

/** '' for a non-group-scoped descriptor (Notification Targets); the resolved Worker Group otherwise. */
function groupOf(desc: EntityDescriptor, fields: Record<string, unknown>, settings: Record<string, unknown>): string {
  return desc.groupScoped === false ? '' : resolveWorkerGroup(fields, settings)
}

// --- validate (static) -------------------------------------------------------

/**
 * Validate entity items: a non-empty, well-formed id; a non-empty type; and a
 * `conf` that parses to a JSON object. The id is the stable identity, scoped per
 * Worker Group, so a duplicate id within the same group is flagged (last wins).
 */
export function validateEntities(ctx: PipelineContext, desc: EntityDescriptor): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const settings = ctx.settings ?? {}

  if (items.length === 0) {
    errors.push({ field: 'items', message: `Add at least one ${desc.kind}.`, code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const id = String(item.fields.id ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const group = groupOf(desc, item.fields, settings)
    const scopedId = `${group}/${id}`

    if (!id) {
      errors.push({ field: `items[${i}].id`, message: `${desc.Kind} ID is required.`, code: 'EMPTY_ID' })
    } else if (!CRIBL_ID_RE.test(id)) {
      errors.push({
        field: `items[${i}].id`,
        message: `${desc.Kind} ID "${id}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_ID',
      })
    } else if (seen.has(scopedId)) {
      const scope = desc.groupScoped === false ? '' : ` for group ${group || '(single-instance)'}`
      warnings.push({
        field: `items[${i}].id`,
        message: `${desc.Kind} ID ${id} is listed more than once${scope}; the last one wins.`,
        code: 'DUPLICATE_ID',
      })
    } else {
      seen.add(scopedId)
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: `${desc.Kind} type is required (e.g. the Cribl integration type).`, code: 'EMPTY_TYPE' })
    }

    const { error } = parseJsonObject(item.fields.conf, 'conf')
    if (error) errors.push({ field: `items[${i}].conf`, message: error, code: 'INVALID_CONF' })
  })

  return { valid: errors.length === 0, errors, warnings }
}

// --- deploy ------------------------------------------------------------------

/**
 * Deploy entities over the REST API, upserting by id: create (POST) when the id
 * is new to the group, otherwise update (PATCH /…/<id>). rollbackData records the
 * prior object (null when it did not exist) plus its group, so rollback restores
 * or removes it. Live lists are read once per Worker Group and reused.
 */
export async function deployEntities(ctx: DeployContext, desc: EntityDescriptor): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} deployment` }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  const previous: Array<{ id: string; group: string; entity: SystemEntity | null }> = []
  const applied: string[] = []
  const liveByGroup = new Map<string, SystemEntity[]>()

  try {
    const headers = await criblConnect(base, credential)

    for (const item of items) {
      const id = String(item.fields.id ?? '').trim()
      const type = String(item.fields.type ?? '').trim()
      if (!id) continue

      const { value: conf, error } = parseJsonObject(item.fields.conf, 'conf')
      if (error || !conf) {
        return { success: false, message: `${desc.Kind} ${id}: ${error ?? 'invalid conf'}`, artifacts: { applied }, rollbackData: { previous } }
      }
      if (!type) {
        return { success: false, message: `${desc.Kind} ${id}: type is required.`, artifacts: { applied }, rollbackData: { previous } }
      }

      const group = groupOf(desc, item.fields, settings ?? {})
      if (!liveByGroup.has(group)) liveByGroup.set(group, await listEntities(base, headers, group, desc))
      const live = liveByGroup.get(group)!

      const existing = findById(live, id)
      const body = buildEntityBody(id, type, conf)

      if (existing) {
        await sendJson('PATCH', `${resourcePathFor(base, desc, group)}/${encodeURIComponent(id)}`, headers, body)
        previous.push({ id, group, entity: existing })
      } else {
        await sendJson('POST', resourcePathFor(base, desc, group), headers, body)
        previous.push({ id, group, entity: null })
      }
      applied.push(group ? `${group}/${id}` : id)
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

// --- rollback ----------------------------------------------------------------

/**
 * Undo an entity deploy from rollbackData.previous: restore the prior object
 * (PATCH /…/<id>), or — when it was newly created (prior null) — remove it
 * (DELETE /…/<id>).
 */
export async function rollbackEntities(ctx: RollbackContext, desc: EntityDescriptor): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ id: string; group: string; entity: SystemEntity | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} rollback` }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let restored = 0
  let removed = 0
  try {
    const headers = await criblConnect(base, credential)

    for (const { id, group, entity } of previous) {
      if (!id) continue
      const url = `${resourcePathFor(base, desc, group)}/${encodeURIComponent(id)}`
      if (entity) {
        await sendJson('PATCH', url, headers, entity)
        restored++
      } else {
        await sendJson('DELETE', url, headers)
        removed++
      }
    }
    return { success: true, message: `Rolled back ${desc.kind}s: ${restored} restored, ${removed} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

// --- drift -------------------------------------------------------------------

/**
 * Drift for entities: compare the object we declare against the live one
 * (read-only GET). An entity we declare but that is missing in Cribl is critical
 * drift; a differing config is a warning. Only the keys WE declare (type + conf)
 * are compared, so Cribl's server-injected defaults raise no false drift.
 * Best-effort — a group we can't read is skipped. Verify against a live Cribl.
 */
export async function driftEntities(ctx: DriftContext, desc: EntityDescriptor): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  let headers: Record<string, string>
  try {
    headers = await criblConnect(base, credential)
  } catch {
    return { hasDrift: false, diffs }
  }

  const liveByGroup = new Map<string, SystemEntity[] | null>()
  const loadGroup = async (group: string): Promise<SystemEntity[] | null> => {
    if (liveByGroup.has(group)) return liveByGroup.get(group)!
    let live: SystemEntity[] | null
    try {
      live = itemsFromList<SystemEntity>(await getJson<unknown>(resourcePathFor(base, desc, group), headers))
    } catch {
      live = null
    }
    liveByGroup.set(group, live)
    return live
  }

  for (const item of items) {
    const id = String(item.fields.id ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    if (!id) continue

    const group = groupOf(desc, item.fields, settings ?? {})
    const live = await loadGroup(group)
    if (live === null) continue

    const label = group ? `${group}/${id}` : id
    const match = findById(live, id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const { value: conf } = parseJsonObject(item.fields.conf, 'conf')
    if (!conf) continue
    const keys = declaredKeys(type, conf)
    const expected = pickKeys(buildEntityBody(id, type, conf), keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: `${label}.conf`, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
