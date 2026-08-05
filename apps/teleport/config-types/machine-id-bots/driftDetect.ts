import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient } from '../../lib/teleport'
import { getBot } from './deploy'
import { extractBotSpecs, durationToSeconds, type BotTrait } from './validate'

function sortedTraits(traits: BotTrait[]): string {
  return [...traits]
    .map((t) => `${t.name}=${[...t.values].sort().join(',')}`)
    .sort()
    .join(';')
}

/**
 * Detect drift between the deployed bot configuration and live Teleport
 * state. Re-reads each declared bot by name and compares roles (order-
 * insensitive), traits, and max session TTL (unit-normalized — see
 * validate.ts's `durationToSeconds`).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractBotSpecs(ctx.deployedConfig).filter((s) => s.botName && s.roles.length > 0)

  for (const spec of specs) {
    try {
      const live = await getBot(client, spec.botName)

      if (!live) {
        diffs.push({ field: spec.botName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expectedRoles = [...spec.roles].sort().join(',')
      const actualRoles = [...live.roles].sort().join(',')
      if (expectedRoles !== actualRoles) {
        diffs.push({ field: `${spec.botName}.roles`, expected: expectedRoles, actual: actualRoles, severity: 'critical' })
      }

      const expectedTraits = sortedTraits(spec.traits)
      const actualTraits = sortedTraits(live.traits)
      if (expectedTraits !== actualTraits) {
        diffs.push({ field: `${spec.botName}.traits`, expected: expectedTraits, actual: actualTraits, severity: 'warning' })
      }

      if (spec.maxSessionTtl) {
        const expectedSeconds = durationToSeconds(spec.maxSessionTtl)
        const actualSeconds = live.maxSessionTtl ? durationToSeconds(live.maxSessionTtl) : null
        if (expectedSeconds !== null && expectedSeconds !== actualSeconds) {
          diffs.push({
            field: `${spec.botName}.maxSessionTtl`,
            expected: spec.maxSessionTtl,
            actual: live.maxSessionTtl ?? 'unset',
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: spec.botName,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
