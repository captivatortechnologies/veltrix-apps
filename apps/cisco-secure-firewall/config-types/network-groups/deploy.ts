import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, upsertByName, type DeployedObject, type UpsertSpec } from '../../lib/fmc'
import { buildNetworkObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractNetworkGroupSpecs, buildNetworkGroupBaseFields, NETWORK_GROUPS_PATH } from './validate'

/**
 * Deploy Network Groups: resolve each member name against the live
 * Host/Network/Range/FQDN/Network Group index (lib/fmcRefs.ts), then upsert
 * the group with its resolved `objects: [{id, type}]` member list. Fails
 * fast — before writing anything — if any group references a name that does
 * not resolve, naming exactly which group and which names are unresolved.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const specs = extractNetworkGroupSpecs(ctx.canvas).filter((s) => s.name && s.memberNames.length > 0)
  const index = await buildNetworkObjectIndex(client)

  const upsertSpecs: UpsertSpec[] = []
  const unresolved: string[] = []
  for (const spec of specs) {
    const { resolved, missing } = resolveRefs(index, spec.memberNames)
    if (missing.length > 0) {
      unresolved.push(`"${spec.name}": ${missing.join(', ')}`)
      continue
    }
    upsertSpecs.push({
      name: spec.name,
      fields: { ...buildNetworkGroupBaseFields(spec), objects: resolved.map((r) => ({ id: r.id, type: r.type })) },
    })
  }

  if (unresolved.length > 0) {
    return {
      success: false,
      message:
        `Cannot deploy - some referenced network objects do not exist in FMC: ${unresolved.join('; ')}. ` +
        'Create them first (this app\'s Network Objects config type) or fix the name.',
    }
  }

  const rollback: DeployedObject[] = []
  const deployed: string[] = []
  try {
    await upsertByName(client, NETWORK_GROUPS_PATH, upsertSpecs, rollback, deployed)
    const activation = await deployToDevicesIfEnabled(client, settings)
    return {
      success: true,
      message: `Deployed ${deployed.length} network group(s) to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback, path: NETWORK_GROUPS_PATH },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network group deploy failed after ${deployed.length} of ${upsertSpecs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback, path: NETWORK_GROUPS_PATH },
    }
  }
}
