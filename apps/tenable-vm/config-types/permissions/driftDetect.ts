import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient } from '../../lib/tenable'
import { attachDriftActor, veltrixActorLogins } from '../lib/tenableAudit'
import { findPermissionByName, getPermissionByUuid } from './deploy'
import { extractPermissionSpecs, parseJsonArray } from './validate'

/**
 * Detect drift between the deployed permission configuration and the live
 * tenant state. Re-finds each declared permission by name, then GETs it by uuid
 * and diffs the meaningful fields (actions, objects, subjects) — every one of
 * which is a privilege boundary, so any difference is treated as critical.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPermissionSpecs(ctx.deployedConfig).filter((s) => s.name)
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  for (const spec of specs) {
    const before = diffs.length
    const label = spec.name
    try {
      const found = await findPermissionByName(client, spec.name)
      if (!found || !found.permission_uuid) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }

      // GET the authoritative record by its stable uuid.
      const live = (await getPermissionByUuid(client, found.permission_uuid)) ?? found

      // actions — a set (order-insensitive); changing them changes granted rights.
      const expectedActions = normalizeStringSet(spec.actions)
      const actualActions = normalizeStringSet(live.actions)
      if (expectedActions !== actualActions) {
        diffs.push({
          field: `${label}.actions`,
          expected: expectedActions || 'not set',
          actual: actualActions || 'not set',
          severity: 'critical',
        })
      }

      // objects — WHAT the permission applies to. Treated as a set: element
      // order, key order and whitespace are canonicalized so they do not drift.
      const expectedObjects = normalizeEntities(parseRaw(spec.objectsJson))
      const actualObjects = normalizeEntities(live.objects)
      if (expectedObjects !== actualObjects) {
        diffs.push({
          field: `${label}.objects`,
          expected: expectedObjects || 'not set',
          actual: actualObjects || 'not set',
          severity: 'critical',
        })
      }

      // subjects — WHO the permission is granted to (also a set).
      const expectedSubjects = normalizeEntities(parseRaw(spec.subjectsJson))
      const actualSubjects = normalizeEntities(live.subjects)
      if (expectedSubjects !== actualSubjects) {
        diffs.push({
          field: `${label}.subjects`,
          expected: expectedSubjects || 'not set',
          actual: actualSubjects || 'not set',
          severity: 'critical',
        })
      }

      // Attribute every diff this permission produced to the last change (once).
      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.permission_uuid,
        targetName: spec.name,
        excludeActorLogins,
      })
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Canonicalize a string list to a stable, order-insensitive comparison string. */
function normalizeStringSet(values: unknown): string {
  if (!Array.isArray(values)) return ''
  return [...values.map((v) => String(v))].sort().join(',')
}

/** Parse a raw JSON-array string; null when absent/invalid. */
function parseRaw(raw: string | undefined): unknown[] | null {
  return raw ? parseJsonArray(raw) : null
}

/**
 * Canonicalize an objects/subjects array as an order-insensitive SET: each
 * element is stable-stringified (keys sorted), the elements are then sorted and
 * joined, so re-ordered-but-equal sets do not read as drift.
 */
function normalizeEntities(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map(stableStringify)
    .sort()
    .join('|')
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
