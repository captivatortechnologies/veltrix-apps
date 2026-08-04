import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader } from '../../lib/fleetApi'
import { normalizeItem, groupByScope, getSecretsForScope } from './_shared'

/**
 * Drift for enroll secrets: per scope, compare the SET of declared secret
 * values against the live set. Fleet returns enroll secrets in plaintext on
 * read (unlike a third-party API credential), so this is a full comparison,
 * not just a presence check. Best-effort — a scope that can't be read is
 * skipped rather than raising false drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const rawItems = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const items = rawItems.map((item) => normalizeItem(item.fields)).filter((item) => item.label && item.value)
  const groups = groupByScope(items)

  for (const [teamId, scopeItems] of groups) {
    const scopeLabel = teamId === undefined ? 'global' : `team ${teamId}`
    const live = await getSecretsForScope(base, headers, teamId)
    const liveSet = new Set(live)
    const declaredSet = new Set(scopeItems.map((item) => item.value))

    if (declaredSet.size !== liveSet.size || [...declaredSet].some((v) => !liveSet.has(v))) {
      diffs.push({
        field: `${scopeLabel}.secrets`,
        expected: `${declaredSet.size} declared secret(s)`,
        actual: `${liveSet.size} live secret(s) — values differ`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
