import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listObservableTypes } from '../../lib/thehiveApi'
import { buildObservableTypeBody, findObservableType, observableTypesFromList, parseBool, type ObservableType } from './_shared'

/**
 * Drift for observable types: a declared type MISSING in TheHive is drift
 * (deploy would create it); a present type whose isAttachment differs is drift
 * that deploy CANNOT correct (no update endpoint) — flagged so an operator can
 * recreate it deliberately. Best-effort and read-only. Verify against a live
 * TheHive (see README).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: ObservableType[]
  try {
    live = observableTypesFromList(await listObservableTypes<ObservableType>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read types, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const desired = buildObservableTypeBody(item.fields)
    const match = findObservableType(live, name)

    if (!match) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }
    const actualIsAttachment = parseBool(match.isAttachment)
    if (desired.isAttachment !== actualIsAttachment) {
      diffs.push({ field: `${name}.isAttachment`, expected: desired.isAttachment, actual: actualIsAttachment, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
