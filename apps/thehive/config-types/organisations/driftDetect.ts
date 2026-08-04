import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listOrganisations } from '../../lib/thehiveApi'
import { buildOrganisationUpdateBody, findOrganisation, organisationsFromList, type Organisation } from './_shared'

/**
 * Drift for organisations: compare the declared description / sharing rules /
 * locked flag against the live organisation in TheHive. Best-effort — an
 * organisation that can't be matched (missing / transient error) is skipped
 * rather than raising false drift. Read-only. Verify against a live TheHive
 * (see README, v4 vs v5).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: Organisation[]
  try {
    live = organisationsFromList(await listOrganisations<Organisation>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read organisations, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findOrganisation(live, name)
    if (!match) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desired = buildOrganisationUpdateBody(item.fields)

    const actualDescription = String(match.description ?? '').trim()
    if (desired.description !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: desired.description, actual: actualDescription, severity: 'info' })
    }
    if (desired.taskRule !== (match.taskRule ?? 'manual')) {
      diffs.push({ field: `${name}.taskRule`, expected: desired.taskRule, actual: match.taskRule ?? 'manual', severity: 'warning' })
    }
    if (desired.observableRule !== (match.observableRule ?? 'manual')) {
      diffs.push({ field: `${name}.observableRule`, expected: desired.observableRule, actual: match.observableRule ?? 'manual', severity: 'warning' })
    }
    const actualLocked = Boolean(match.locked)
    if (desired.locked !== actualLocked) {
      diffs.push({ field: `${name}.locked`, expected: desired.locked, actual: actualLocked, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
