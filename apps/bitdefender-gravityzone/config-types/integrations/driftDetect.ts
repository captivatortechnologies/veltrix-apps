import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getIntegrationDetails } from '../../lib/gravityZoneApi'
import { extractIntegrationSpecs, findLiveIntegration, integrationFieldsMatch, listAllIntegrations, liveIntegrationId, parseSpecifics } from './_shared'

/**
 * Detect drift for integrations: for each declared name, find the live
 * integration (full detail via integrations.getIntegrationDetails) and
 * compare name/specifics. A missing integration is critical drift; a
 * changed specifics object is a warning. `type` is immutable and not
 * compared — see deploy.ts.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractIntegrationSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live
  try {
    live = await listAllIntegrations(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }

  for (const spec of specs) {
    const match = findLiveIntegration(live, spec.name)
    if (!match) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const full = (await getIntegrationDetails(client, liveIntegrationId(match))) ?? match
    const { value: specifics } = parseSpecifics(spec)
    if (!integrationFieldsMatch(spec, specifics, full)) {
      diffs.push({
        field: `${spec.name}.specifics`,
        expected: specifics ?? {},
        actual: full.specifics ?? {},
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
