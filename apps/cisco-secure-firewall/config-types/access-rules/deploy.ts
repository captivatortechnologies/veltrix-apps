import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, upsertByName, type DeployedObject, type UpsertSpec } from '../../lib/fmc'
import { buildAccessControlPolicyIndex, buildZoneIndex, buildNetworkObjectIndex, buildPortObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractAccessRuleSpecs, buildAccessRuleFields, accessRulesPath, type AccessRuleSpec, type ResolvedAccessRuleRefs } from './validate'

/** A rollback entry needs its own `path` — rules in one canvas may belong to different policies. */
export interface AccessRuleRollbackEntry extends DeployedObject {
  path: string
}

interface ResolvedRule {
  spec: AccessRuleSpec
  policyId: string
  refs: ResolvedAccessRuleRefs
}

/**
 * Deploy access rules: resolve each rule's owning policy AND every zone/
 * network/port reference against live FMC state, then upsert each policy's
 * rules against its own `/policy/accesspolicies/{id}/accessrules` path.
 * Fails BEFORE writing anything if any reference (policy, zone, network or
 * port) does not resolve, naming exactly which rule and which names.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const specs = extractAccessRuleSpecs(ctx.canvas).filter((s) => s.policyName && s.name)
  const [policyIndex, zoneIndex, networkIndex, portIndex] = await Promise.all([
    buildAccessControlPolicyIndex(client),
    buildZoneIndex(client),
    buildNetworkObjectIndex(client),
    buildPortObjectIndex(client),
  ])

  const problems: string[] = []
  const resolvedRules: ResolvedRule[] = []

  for (const spec of specs) {
    const policy = policyIndex.get(spec.policyName.toLowerCase())
    if (!policy) {
      problems.push(`rule "${spec.name}": Access Control Policy "${spec.policyName}" was not found - deploy Access Control Policies first`)
      continue
    }

    const sz = resolveRefs(zoneIndex, spec.sourceZones)
    const dz = resolveRefs(zoneIndex, spec.destinationZones)
    const sn = resolveRefs(networkIndex, spec.sourceNetworks)
    const dn = resolveRefs(networkIndex, spec.destinationNetworks)
    const sp = resolveRefs(portIndex, spec.sourcePorts)
    const dp = resolveRefs(portIndex, spec.destinationPorts)
    const missing = [...sz.missing, ...dz.missing, ...sn.missing, ...dn.missing, ...sp.missing, ...dp.missing]
    if (missing.length > 0) {
      problems.push(`rule "${spec.name}": referenced objects not found - ${[...new Set(missing)].join(', ')}`)
      continue
    }

    resolvedRules.push({
      spec,
      policyId: policy.id,
      refs: {
        sourceZones: sz.resolved,
        destinationZones: dz.resolved,
        sourceNetworks: sn.resolved,
        destinationNetworks: dn.resolved,
        sourcePorts: sp.resolved,
        destinationPorts: dp.resolved,
      },
    })
  }

  if (problems.length > 0) {
    return { success: false, message: `Cannot deploy - ${problems.join('; ')}.` }
  }

  const byPolicy = new Map<string, { path: string; specs: UpsertSpec[] }>()
  for (const { spec, policyId, refs } of resolvedRules) {
    const path = accessRulesPath(policyId)
    const group = byPolicy.get(policyId) ?? { path, specs: [] }
    group.specs.push({ name: spec.name, fields: buildAccessRuleFields(spec, refs) })
    byPolicy.set(policyId, group)
  }

  const rollback: AccessRuleRollbackEntry[] = []
  const deployed: string[] = []
  try {
    for (const { path, specs: policySpecs } of byPolicy.values()) {
      const policyRollback: DeployedObject[] = []
      await upsertByName(client, path, policySpecs, policyRollback, deployed)
      rollback.push(...policyRollback.map((entry) => ({ ...entry, path })))
    }

    const activation = await deployToDevicesIfEnabled(client, settings)
    return {
      success: true,
      message: `Deployed ${deployed.length} access rule(s) to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback },
    }
  } catch (error) {
    return {
      success: false,
      message: `Access rule deploy failed after ${deployed.length} of ${resolvedRules.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback },
    }
  }
}
