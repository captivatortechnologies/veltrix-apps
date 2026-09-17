import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildIscClient, readIscSettings, resolveIscCredential } from '../../lib/isc'
import type { LiveSource } from '../sources/validate'
import { extractProvisioningPolicySpecs, type LiveProvisioningPolicy } from './validate'

const SOURCES = '/v3/sources'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readIscSettings(ctx.settings)
  const cred = resolveIscCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildIscClient(cred, settings)

  const specs = extractProvisioningPolicySpecs(ctx.deployedConfig).filter((s) => s.name && s.sourceName)
  const sourcesRes = await client.getAll<LiveSource>(SOURCES)
  if (!sourcesRes.ok) return { hasDrift: false, diffs: [], checked: false }
  const sourceByName = new Map(sourcesRes.items.filter((s) => s.name && s.id).map((s) => [s.name!.toLowerCase(), s]))

  const childCache = new Map<string, Map<string, LiveProvisioningPolicy> | null>()
  const diffs: Diffs = []
  // Cleared when a child collection could not be read, so the run reports
  // `checked: false` rather than "in sync" from a partial view.
  let checkedAll = true
  for (const spec of specs) {
    const source = sourceByName.get(spec.sourceName.toLowerCase())
    if (!source?.id) {
      diffs.push({ field: `${spec.sourceName}/${spec.usageType}`, expected: 'present', actual: 'source absent', severity: 'critical' })
      continue
    }
    let children = childCache.get(source.id)
    if (children === undefined) {
      const listed = await client.getAll<LiveProvisioningPolicy>(`${SOURCES}/${source.id}/provisioning-policies`)
      // A REFUSED child listing is not an empty one. Reporting every declared
      // child as critically absent because one read failed pages somebody for a
      // deletion that never happened — and the obvious remedy is a redeploy.
      children = listed.ok ? new Map(listed.items.filter((p) => p.usageType).map((p) => [p.usageType!, p])) : null
      childCache.set(source.id, children)
    }
    if (children === null) {
      checkedAll = false
      continue
    }
    const live = children.get(spec.usageType)
    if (!live) {
      diffs.push({ field: `${spec.sourceName}/${spec.usageType}`, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.name && (live.name ?? '') !== spec.name) {
      diffs.push({ field: `${spec.sourceName}/${spec.usageType}.name`, expected: spec.name, actual: live.name ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
