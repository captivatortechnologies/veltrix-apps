import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getCompanyDetails } from '../../lib/gravityZoneApi'
import { buildCompanyUpdateBody, companyFieldsMatch, declaredLiveSnapshot, extractCompanyProfileSpecs, parseContactPerson, parseMdrContactInformation } from './_shared'

/**
 * Detect drift for company profile declarations: re-fetch
 * companies.getCompanyDetails per declared companyId and compare every
 * field the canvas declared non-blank. A getCompanyDetails failure (e.g. an
 * invalid companyId) is critical drift; a changed declared field is a
 * warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractCompanyProfileSpecs(ctx.deployedConfig)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const label = spec.companyId || '(own company)'
    let live
    try {
      live = await getCompanyDetails(client, spec.companyId || undefined)
    } catch (error) {
      diffs.push({ field: label, expected: 'reachable', actual: error instanceof Error ? error.message : 'unreachable', severity: 'critical' })
      continue
    }

    const { value: contactPerson } = parseContactPerson(spec)
    const { value: mdrContactInformation } = parseMdrContactInformation(spec)
    if (!companyFieldsMatch(spec, contactPerson, mdrContactInformation, live)) {
      const expected = buildCompanyUpdateBody(spec, contactPerson, mdrContactInformation)
      delete expected.companyId
      diffs.push({ field: `${label}.profile`, expected, actual: declaredLiveSnapshot(spec, live), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
