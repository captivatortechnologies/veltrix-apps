import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, type FmcObject } from '../../lib/fmc'
import { buildAccessControlPolicyIndex, buildZoneIndex, buildNetworkObjectIndex, buildPortObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractAccessRuleSpecs, accessRuleDriftDiffs, accessRulesPath } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractAccessRuleSpecs(ctx.deployedConfig).filter((s) => s.policyName && s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const [policyIndex, zoneIndex, networkIndex, portIndex] = await Promise.all([
    buildAccessControlPolicyIndex(client),
    buildZoneIndex(client),
    buildNetworkObjectIndex(client),
    buildPortObjectIndex(client),
  ])

  const diffs: DriftDiff[] = []
  const rulesListCache = new Map<string, Map<string, FmcObject>>()

  for (const spec of specs) {
    const policy = policyIndex.get(spec.policyName.toLowerCase())
    if (!policy) {
      diffs.push({ field: `${spec.name}.policy_name`, expected: spec.policyName, actual: 'policy not found', severity: 'critical' })
      continue
    }

    let byName = rulesListCache.get(policy.id)
    if (!byName) {
      const listed = await client.list(accessRulesPath(policy.id))
      if (!listed.ok) {
        diffs.push({
          field: `${spec.policyName}.accessrules`,
          expected: 'reachable',
          actual: `list failed (HTTP ${listed.status})`,
          severity: 'critical',
        })
        rulesListCache.set(policy.id, new Map())
        continue
      }
      byName = new Map(listed.items.map((item) => [(item.name ?? '').toLowerCase(), item]))
      rulesListCache.set(policy.id, byName)
    }

    const live = byName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const sz = resolveRefs(zoneIndex, spec.sourceZones)
    const dz = resolveRefs(zoneIndex, spec.destinationZones)
    const sn = resolveRefs(networkIndex, spec.sourceNetworks)
    const dn = resolveRefs(networkIndex, spec.destinationNetworks)
    const sp = resolveRefs(portIndex, spec.sourcePorts)
    const dp = resolveRefs(portIndex, spec.destinationPorts)

    diffs.push(
      ...accessRuleDriftDiffs(
        spec,
        {
          sourceZones: sz.resolved,
          destinationZones: dz.resolved,
          sourceNetworks: sn.resolved,
          destinationNetworks: dn.resolved,
          sourcePorts: sp.resolved,
          destinationPorts: dp.resolved,
        },
        live,
      ),
    )
  }

  return { hasDrift: diffs.length > 0, diffs }
}
