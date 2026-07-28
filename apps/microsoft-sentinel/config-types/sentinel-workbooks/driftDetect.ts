import { createHash } from 'node:crypto'
import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { findWorkbookByDisplayName, listSentinelWorkbooks, workbookResourcePath, workspaceSourceId } from './deploy'
import { extractWorkbookSpecs } from './validate'

/** Recursively key-sort a JSON value so re-serialization order never reads as drift. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortValue((value as Record<string, unknown>)[key])
        return acc
      }, {})
  }
  return value
}

/**
 * Canonicalize serializedData for comparison: parse + key-sorted re-stringify so
 * whitespace and key-order changes (Azure normalizes the blob on save) do not
 * register as drift. Falls back to the trimmed raw string when it does not parse.
 */
export function canonicalizeSerializedData(raw: string): string {
  try {
    return JSON.stringify(sortValue(JSON.parse(raw)))
  } catch {
    return (raw ?? '').trim()
  }
}

/** Stable content hash of a workbook's serializedData blob (used for the drift label + parse-failure fallback). */
export function serializedDataHash(raw: string): string {
  return createHash('sha256').update(canonicalizeSerializedData(raw ?? ''), 'utf8').digest('hex')
}

/** Deep containment: is every value in `declared` present (and equal) in `live`? */
function contains(declared: unknown, live: unknown): boolean {
  if (declared === null || typeof declared !== 'object') return declared === live
  if (Array.isArray(declared)) {
    // Item ORDER is significant in a workbook, so compare element-wise; a length
    // change (an item added/removed) is real drift.
    if (!Array.isArray(live) || live.length !== declared.length) return false
    return declared.every((d, i) => contains(d, live[i]))
  }
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false
  const l = live as Record<string, unknown>
  const d = declared as Record<string, unknown>
  return Object.keys(d).every((k) => contains(d[k], l[k]))
}

/**
 * Does the LIVE serializedData still carry everything the DEPLOYED blob declares
 * (same values), IGNORING any extra keys Azure injects server-side on save?
 *
 * Azure enriches a workbook with default properties on PUT — both top-level and
 * per-item — so a whole-blob hash mismatch is a false positive. Drift should fire
 * only when a key WE set is missing or changed, or an item is added/removed; a
 * server-added default key is not our drift. (A value NORMALIZED server-side would
 * still show — that narrower case can be handled by stripping specific keys if
 * ever observed.) Falls back to canonical-hash equality when either blob isn't JSON.
 */
export function serializedDataContains(deployedRaw: string, liveRaw: string): boolean {
  let declared: unknown
  let live: unknown
  try {
    declared = JSON.parse(deployedRaw)
    live = JSON.parse(liveRaw)
  } catch {
    return canonicalizeSerializedData(deployedRaw ?? '') === canonicalizeSerializedData(liveRaw ?? '')
  }
  return contains(declared, live)
}

/** A short, human-readable hash label for a drift diff (never dumps the whole blob). */
function hashLabel(raw: string): string {
  return `sha256:${serializedDataHash(raw).slice(0, 12)}`
}

/**
 * Detect drift between the deployed workbooks and the live workspace. A declared
 * workbook that no longer exists is critical drift; a display name that differs, or
 * a serializedData blob that no longer CONTAINS the declared content (ignoring the
 * default properties Azure adds server-side), is warning drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractWorkbookSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const sourceId = workspaceSourceId(client)
    const live = await listSentinelWorkbooks(client, true)

    for (const spec of specs) {
      const before = diffs.length
      const match = findWorkbookByDisplayName(live, spec.displayName, sourceId)
      if (!match) {
        diffs.push({ field: `workbook:${spec.displayName}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        // No resource id to attribute a missing workbook to — attach is a no-op.
        continue
      }

      const resourceId = match.id ?? (match.name ? workbookResourcePath(client, match.name) : undefined)
      const props = match.properties ?? {}

      if (spec.displayName !== (props.displayName ?? '')) {
        diffs.push({ field: `${spec.displayName}.displayName`, expected: spec.displayName, actual: props.displayName ?? '', severity: 'warning' })
      }

      // Content drift: the live blob no longer contains what we declared. Azure's
      // server-added default properties are ignored so they don't read as drift.
      if (!serializedDataContains(spec.serializedData, props.serializedData ?? '')) {
        diffs.push({
          field: `${spec.displayName}.serializedData`,
          expected: hashLabel(spec.serializedData),
          actual: hashLabel(props.serializedData ?? ''),
          severity: 'warning',
        })
      }

      // Attribute every diff this workbook produced to the last human change
      // (once); a no-op (no query) when the workbook did not drift.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
