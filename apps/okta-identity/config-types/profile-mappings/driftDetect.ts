import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient } from '../../lib/okta'
import { getMappingById, mappingLabel, resolveMapping } from './deploy'
import { extractMappingSpecs, parseConfigObject } from './validate'

/**
 * Detect drift between the deployed profile-mapping configuration and the live Okta
 * org. For each declared mapping, only the MANAGED property mappings are compared:
 *   - an unresolved (source, target) mapping is CRITICAL (missing).
 *   - a managed property declared as a REMOVAL (`expression: null`) should be ABSENT;
 *     a lingering one is a WARNING.
 *   - a managed property declared with an expression should be PRESENT and match on
 *     `expression` + `pushStatus`; a missing or differing one is CRITICAL.
 * Unmanaged property mappings on the same mapping are never inspected.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractMappingSpecs(ctx.deployedConfig).filter((s) => s.sourceId && s.targetId && s.propertiesJson)

  for (const spec of specs) {
    const label = mappingLabel(spec.sourceId, spec.targetId)
    const declared = spec.propertiesJson ? parseConfigObject(spec.propertiesJson) : null
    if (!declared) continue

    try {
      // Resolve + fetch the full mapping. An unresolved mapping throws -> critical below.
      const resolved = await resolveMapping(client, spec.sourceId, spec.targetId)
      const full = resolved.id ? await getMappingById(client, resolved.id) : null
      if (!full) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveProps = full.properties ?? {}
      for (const [name, desiredRaw] of Object.entries(declared)) {
        const desired =
          desiredRaw && typeof desiredRaw === 'object' && !Array.isArray(desiredRaw)
            ? (desiredRaw as { expression?: unknown; pushStatus?: unknown })
            : {}
        const present = Object.prototype.hasOwnProperty.call(liveProps, name)
        const liveVal = liveProps[name]

        const isRemoval = desired.expression === null && desired.pushStatus === null
        if (isRemoval) {
          // Declared for removal — it should be absent on live.
          if (present) {
            diffs.push({ field: `${label}.${name}`, expected: 'absent', actual: 'present', severity: 'warning' })
          }
          continue
        }

        if (!present) {
          diffs.push({ field: `${label}.${name}`, expected: 'present', actual: 'missing', severity: 'critical' })
          continue
        }

        const desiredExpr = typeof desired.expression === 'string' ? desired.expression : ''
        const desiredPush = typeof desired.pushStatus === 'string' ? desired.pushStatus.toUpperCase() : ''
        const liveExpr = typeof liveVal?.expression === 'string' ? liveVal.expression : ''
        const livePush = typeof liveVal?.pushStatus === 'string' ? liveVal.pushStatus.toUpperCase() : ''

        if (liveExpr !== desiredExpr || livePush !== desiredPush) {
          diffs.push({
            field: `${label}.${name}`,
            expected: `${desiredExpr} (${desiredPush || 'none'})`,
            actual: `${liveExpr || 'none'} (${livePush || 'none'})`,
            severity: 'critical',
          })
        }
      }
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
