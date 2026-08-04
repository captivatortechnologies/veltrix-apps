// =============================================================================
// Cribl "record" engine — shared by every Cribl Knowledge/Security/Packs config
// type that models ONE FLAT NAMED RECORD (an id plus a handful of its own typed
// fields — NOT the `{ id, type, ...conf }` spread that Sources/Destinations use
// in lib/criblSystemEntities). Lookups, Regex/Grok library entries, Parsers,
// Event Breaker Rulesets, Schemas, Global Variables, Subscriptions,
// Notifications, Database Connections, Packs, Secrets, Certificates, Keys and
// HMAC Functions all share this identical CRUD lifecycle:
//   list   : GET    <resource>            (group-scoped or flat, see EntityDescriptor)
//   create : POST   <resource>            body = the record
//   update : PATCH  <resource>/<id>       body = the record
//   delete : DELETE <resource>/<id>
// and differ only in which fields make up "the record" — supplied per config
// type via a `buildRecord(fields, settings) => { id, body, error }` callback.
//
// WRITE-ONLY / SECRET fields (a Secret's value, a Certificate's private key, a
// Database Connection's password) are declared via `sensitiveKeys` on the
// descriptor: Cribl never echoes them back on GET, so this engine (a) never
// drift-compares them, and (b) never attempts to restore them on rollback —
// only a NEWLY CREATED record (nothing to leak) is rolled back by deleting it;
// an UPDATED record is left as-is with a clear "not restorable" message. This
// mirrors apps/cisco-ise's internal-users write-only password handling.
//
// NOTE: REST shapes here follow the Cribl OpenAPI spec (v4.14.0, as vendored by
// the official `criblio/terraform-provider-criblio`, cross-checked against
// docs.cribl.io/cribl-as-code/api-reference/). Verify against a live Cribl.
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
import { resolveWorkerGroup, itemsFromList, findByKey, canonicalJson, pickKeys, stripKeys } from './criblCommon'

/** One Cribl named record as returned by the REST API. */
export interface CriblRecord {
  id?: string
  [key: string]: unknown
}

/** Everything the shared handlers need to talk to one Cribl record collection. */
export interface RecordDescriptor {
  /** Resource path segment, e.g. "system/lookups", "lib/regex", "notifications". */
  resource: string
  /** Singular, lower-case noun for messages, e.g. "lookup". */
  kind: string
  /** Title-case noun for messages, e.g. "Lookup". */
  Kind: string
  /** Default true. False = a single global collection at `/api/v1/<resource>` (Notifications). */
  groupScoped?: boolean
  /** The record's identity field on the wire. Default "id" — `system/keys` uses "keyId". */
  identityKey?: string
  /**
   * Body keys that hold write-only secret material (a Secret's `value`, a
   * Certificate's `privKey`). Never drift-compared; never captured verbatim
   * into rollbackData; an UPDATE to a record with any of these keys present is
   * not restored on rollback (see rollbackRecords).
   */
  sensitiveKeys?: string[]
}

/** The outcome of turning one canvas item's fields into a request body. */
export interface RecordSpec {
  /** '' when the item has no identity yet — the caller should skip/report it. */
  id: string
  /** The full request body (including `id`), or null when `error` is set. */
  body: Record<string, unknown> | null
  error: string | null
}

/** Per config type: build the record's id + REST body from its canvas fields. */
export type BuildRecord = (fields: Record<string, unknown>, settings: Record<string, unknown>) => RecordSpec

function resourcePathFor(base: string, desc: RecordDescriptor, group: string): string {
  return desc.groupScoped === false ? `${apiRoot(base)}/${desc.resource}` : groupResourcePath(base, group, desc.resource)
}

function groupOf(desc: RecordDescriptor, fields: Record<string, unknown>, settings: Record<string, unknown>): string {
  return desc.groupScoped === false ? '' : resolveWorkerGroup(fields, settings)
}

async function listRecords(
  base: string,
  headers: Record<string, string>,
  desc: RecordDescriptor,
  group: string,
): Promise<CriblRecord[]> {
  try {
    return itemsFromList<CriblRecord>(await getJson<unknown>(resourcePathFor(base, desc, group), headers))
  } catch {
    return []
  }
}

// --- validate (static) -------------------------------------------------------

/**
 * Validate record items using the type's own `build` callback: an item whose
 * callback reports an error is invalid; a duplicate id (scoped per Worker
 * Group when the collection is group-scoped) is a warning (last one wins).
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
      errors.push({ field: `items[${i}].id`, message: `${desc.Kind} ID is required.`, code: 'EMPTY_ID' })
      return
    }
    if (spec.error) {
      errors.push({ field: `items[${i}]`, message: spec.error, code: 'INVALID' })
      return
    }
    const group = groupOf(desc, item.fields, settings)
    const scopedId = `${group}/${spec.id}`
    if (seen.has(scopedId)) {
      const scope = desc.groupScoped === false ? '' : ` for group ${group || '(single-instance)'}`
      warnings.push({
        field: `items[${i}].id`,
        message: `${desc.Kind} ID ${spec.id} is listed more than once${scope}; the last one wins.`,
        code: 'DUPLICATE_ID',
      })
    } else {
      seen.add(scopedId)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

// --- deploy ------------------------------------------------------------------

/**
 * Deploy records over the REST API, upserting by id: create (POST) when the id
 * is new to the group, otherwise update (PATCH /…/<id>). rollbackData records a
 * SANITIZED prior object (`sensitiveKeys` stripped — never persisted) plus its
 * group; null when it did not exist. Live lists are read once per Worker Group
 * and reused.
 */
export async function deployRecords(ctx: DeployContext, desc: RecordDescriptor, build: BuildRecord): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} deployment` }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)

  const previous: Array<{ id: string; group: string; record: CriblRecord | null }> = []
  const applied: string[] = []
  const liveByGroup = new Map<string, CriblRecord[]>()
  const sensitiveKeys = desc.sensitiveKeys ?? []

  try {
    const headers = await criblConnect(base, credential)

    for (const item of items) {
      const spec = build(item.fields, settings ?? {})
      if (!spec.id) continue
      if (spec.error || !spec.body) {
        return { success: false, message: `${desc.Kind} ${spec.id}: ${spec.error ?? 'invalid configuration'}`, artifacts: { applied }, rollbackData: { previous } }
      }

      const group = groupOf(desc, item.fields, settings ?? {})
      if (!liveByGroup.has(group)) liveByGroup.set(group, await listRecords(base, headers, desc, group))
      const live = liveByGroup.get(group)!

      const existing = findByKey(live, desc.identityKey ?? 'id', spec.id)
      const sanitizedExisting = existing ? (stripKeys(existing, sensitiveKeys) as CriblRecord) : null

      if (existing) {
        await sendJson('PATCH', `${resourcePathFor(base, desc, group)}/${encodeURIComponent(spec.id)}`, headers, spec.body)
        previous.push({ id: spec.id, group, record: sanitizedExisting })
      } else {
        await sendJson('POST', resourcePathFor(base, desc, group), headers, spec.body)
        previous.push({ id: spec.id, group, record: null })
      }
      applied.push(group ? `${group}/${spec.id}` : spec.id)
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
 * Undo a records deploy from rollbackData.previous: a newly-created record
 * (prior null) is removed (DELETE /…/<id>) — safe regardless of secrecy, since
 * nothing about it was ever captured. A record that EXISTED before the deploy
 * is restored (PATCH /…/<id> with the captured — sanitized — prior object)
 * UNLESS the descriptor declares `sensitiveKeys`: Cribl never echoes those
 * back, so the captured snapshot never had them either, and PATCHing it as-is
 * risks clearing a required secret field rather than leaving it untouched.
 * Those entries are left as-is and called out in the result message (same
 * trade-off as apps/cisco-ise's internal-users rollback).
 */
export async function rollbackRecords(ctx: RollbackContext, desc: RecordDescriptor): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: Array<{ id: string; group: string; record: CriblRecord | null }> }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: `Missing credential for ${desc.kind} rollback` }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)
  const hasSensitiveFields = (desc.sensitiveKeys ?? []).length > 0

  let restored = 0
  let removed = 0
  let skipped = 0
  try {
    const headers = await criblConnect(base, credential)

    for (const { id, group, record } of previous) {
      if (!id) continue
      const url = `${resourcePathFor(base, desc, group)}/${encodeURIComponent(id)}`
      if (!record) {
        await sendJson('DELETE', url, headers)
        removed++
      } else if (hasSensitiveFields) {
        skipped++
      } else {
        await sendJson('PATCH', url, headers, record)
        restored++
      }
    }
    const skippedNote = skipped
      ? ` ${skipped} updated ${desc.kind}(s) were NOT restored — Cribl never returns their secret field(s), so the prior value was never captured; update them manually in Cribl if needed.`
      : ''
    return { success: true, message: `Rolled back ${desc.kind}s: ${restored} restored, ${removed} removed.${skippedNote}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}

// --- drift -------------------------------------------------------------------

/**
 * Drift for records: compare the fields we declare (minus `sensitiveKeys`,
 * which Cribl never returns) against the live record (read-only GET). A
 * declared record missing in Cribl is critical drift; a differing field is a
 * warning. Best-effort — a group we can't read is skipped. Verify against a
 * live Cribl.
 */
export async function driftRecords(ctx: DriftContext, desc: RecordDescriptor, build: BuildRecord): Promise<DriftResult> {
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

  const liveByGroup = new Map<string, CriblRecord[] | null>()
  const loadGroup = async (group: string): Promise<CriblRecord[] | null> => {
    if (liveByGroup.has(group)) return liveByGroup.get(group)!
    let live: CriblRecord[] | null
    try {
      live = itemsFromList<CriblRecord>(await getJson<unknown>(resourcePathFor(base, desc, group), headers))
    } catch {
      live = null
    }
    liveByGroup.set(group, live)
    return live
  }

  const sensitiveKeys = desc.sensitiveKeys ?? []

  for (const item of items) {
    const spec = build(item.fields, settings ?? {})
    if (!spec.id || spec.error || !spec.body) continue

    const group = groupOf(desc, item.fields, settings ?? {})
    const live = await loadGroup(group)
    if (live === null) continue

    const label = group ? `${group}/${spec.id}` : spec.id
    const match = findByKey(live, desc.identityKey ?? 'id', spec.id)
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const keys = Object.keys(spec.body).filter((k) => !sensitiveKeys.includes(k))
    const expected = pickKeys(spec.body, keys)
    const actual = pickKeys(match, keys)
    if (canonicalJson(expected) !== canonicalJson(actual)) {
      diffs.push({ field: label, expected, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
