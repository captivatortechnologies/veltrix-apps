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

/** Stable content hash of a workbook's serializedData blob (drift is HASH-compared, not field-diffed). */
export function serializedDataHash(raw: string): string {
  return createHash('sha256').update(canonicalizeSerializedData(raw ?? ''), 'utf8').digest('hex')
}

/** A short, human-readable hash label for a drift diff (never dumps the whole blob). */
function hashLabel(raw: string): string {
  return `sha256:${serializedDataHash(raw).slice(0, 12)}`
}

/**
 * Detect drift between the deployed workbooks and the live workspace. A declared
 * workbook that no longer exists is critical drift; a display name that differs or
 * a serializedData blob whose content hash differs is warning drift. serializedData
 * is an opaque JSON blob, so it is HASH-compared rather than field-diffed.
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

      const wantHash = serializedDataHash(spec.serializedData)
      const haveHash = serializedDataHash(props.serializedData ?? '')
      if (wantHash !== haveHash) {
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
