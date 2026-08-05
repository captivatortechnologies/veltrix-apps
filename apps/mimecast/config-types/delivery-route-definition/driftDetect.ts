import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, extractV1List, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractDeliveryRouteDefinitionSpecs, type LiveDeliveryRouteDefinition } from './validate'
import { definitionEquals } from './deploy'

const LIST = '/policy-management/cloud-gateway/v1/delivery-route/definitions'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractDeliveryRouteDefinitionSpecs(ctx.deployedConfig).filter((s) => s.description && s.hostname)
  const listed = await client.requestV1('GET', LIST, { query: { pageSize: 100 } })
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByDesc = new Map<string, LiveDeliveryRouteDefinition>()
  for (const d of extractV1List<LiveDeliveryRouteDefinition>(listed.body)) {
    if (d.description) liveByDesc.set(d.description.toLowerCase(), d)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByDesc.get(spec.description.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      diffs.push({ field: `${spec.description}.definition`, expected: 'declared hostname/port/alternateRouteId', actual: 'differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
