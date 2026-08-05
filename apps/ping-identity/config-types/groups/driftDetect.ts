import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, stableStringify } from '../../lib/pingOne'
import { findGroupMatch, listGroups } from './deploy'
import { extractGroupSpecs, parseCustomData } from './validate'

/**
 * Detect drift between the deployed group configuration and the live
 * environment. Re-finds each declared group by its logical identity - the
 * PAIR (name, population.id) - and diffs the managed writable fields:
 * description, userFilter, externalId and customData (via stableStringify).
 *
 * Server-managed read-only fields (id, displayName, sourceId, sourceType,
 * directMemberCounts, totalMemberCounts, environment) are never compared -
 * only the fields this config type manages.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)

  let groups
  try {
    groups = await listGroups(client)
  } catch (error) {
    return {
      hasDrift: true,
      diffs: [
        {
          field: 'pingone-environment',
          expected: 'reachable',
          actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
          severity: 'critical',
        },
      ],
    }
  }

  for (const spec of specs) {
    const label = spec.populationId ? `${spec.name} (population ${spec.populationId})` : spec.name
    const live = findGroupMatch(groups, spec.name, spec.populationId)

    if (!live) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = typeof live.description === 'string' ? live.description : ''
    if ((spec.description ?? '') !== liveDescription) {
      diffs.push({
        field: `${label}.description`,
        expected: spec.description ?? 'not set',
        actual: liveDescription || 'not set',
        severity: 'critical',
      })
    }

    // userFilter distinguishes a static group from a dynamic one - treated as
    // critical, same as description.
    const liveUserFilter = typeof live.userFilter === 'string' ? live.userFilter : ''
    if ((spec.userFilter ?? '') !== liveUserFilter) {
      diffs.push({
        field: `${label}.userFilter`,
        expected: spec.userFilter ?? 'not set',
        actual: liveUserFilter || 'not set',
        severity: 'critical',
      })
    }

    const liveExternalId = typeof live.externalId === 'string' ? live.externalId : ''
    if ((spec.externalId ?? '') !== liveExternalId) {
      diffs.push({
        field: `${label}.externalId`,
        expected: spec.externalId ?? 'not set',
        actual: liveExternalId || 'not set',
        severity: 'warning',
      })
    }

    const specCustomData = spec.customDataJson ? (parseCustomData(spec.customDataJson) ?? {}) : {}
    const liveCustomData = live.customData ?? {}
    if (stableStringify(specCustomData) !== stableStringify(liveCustomData)) {
      diffs.push({
        field: `${label}.customData`,
        expected: stableStringify(specCustomData),
        actual: stableStringify(liveCustomData),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
