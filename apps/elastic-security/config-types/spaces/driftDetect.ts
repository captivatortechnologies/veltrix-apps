import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { getSpace } from './deploy'
import { extractSpaceSpecs, type LiveSpace } from './validate'

/**
 * Detect drift between the deployed space configuration and the live Kibana
 * state. Re-fetches each declared space by its (immutable) id and diffs the
 * authored fields, ignoring server-managed fields (`_reserved`, `imageUrl`).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractSpaceSpecs(ctx.deployedConfig).filter((s) => s.id && s.name)

  for (const spec of specs) {
    try {
      const live = await getSpace(client, spec.id)

      if (!live) {
        diffs.push({ field: spec.id, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const before = diffs.length

      // name
      const liveName = typeof live.name === 'string' ? live.name : ''
      if (spec.name !== liveName) {
        diffs.push({
          field: `${spec.id}.name`,
          expected: spec.name,
          actual: liveName || 'not set',
          severity: 'warning',
        })
      }

      // description
      const liveDescription = typeof live.description === 'string' ? live.description : ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.id}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // disabledFeatures — compared as a set (order-independent)
      const expectedFeatures = normalizeSet(spec.disabledFeatures)
      const actualFeatures = normalizeSet(live.disabledFeatures)
      if (expectedFeatures !== actualFeatures) {
        diffs.push({
          field: `${spec.id}.disabledFeatures`,
          expected: expectedFeatures || 'none',
          actual: actualFeatures || 'none',
          severity: 'warning',
        })
      }

      // solution — an unset authored solution accepts whatever Kibana defaulted to.
      if (spec.solution) {
        const liveSolution = typeof live.solution === 'string' ? live.solution : ''
        if (spec.solution !== liveSolution) {
          diffs.push({
            field: `${spec.id}.solution`,
            expected: spec.solution,
            actual: liveSolution || 'not set',
            severity: 'warning',
          })
        }
      }

      // initials
      if (spec.initials !== undefined) {
        const liveInitials = typeof live.initials === 'string' ? live.initials : ''
        if (spec.initials !== liveInitials) {
          diffs.push({
            field: `${spec.id}.initials`,
            expected: spec.initials,
            actual: liveInitials || 'not set',
            severity: 'info',
          })
        }
      }

      // color
      if (spec.color !== undefined) {
        const liveColor = typeof live.color === 'string' ? live.color : ''
        if (spec.color.toLowerCase() !== liveColor.toLowerCase()) {
          diffs.push({
            field: `${spec.id}.color`,
            expected: spec.color,
            actual: liveColor || 'not set',
            severity: 'info',
          })
        }
      }

      // The Kibana Spaces API response carries no modifier field and no
      // per-object audit trail via this API, so this resolves to no actor ("—").
      // Wired uniformly so it attributes automatically if Kibana ever records a
      // modifier — best-effort, never fabricated.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.id,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Canonicalize a list of feature ids to a stable, order-independent string. */
function normalizeSet(value: LiveSpace['disabledFeatures'] | string[]): string {
  if (!Array.isArray(value)) return ''
  return [...value.map((v) => String(v).trim()).filter((v) => v.length > 0)].sort().join(',')
}
