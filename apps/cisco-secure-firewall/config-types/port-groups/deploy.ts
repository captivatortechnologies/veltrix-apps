import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, upsertByName, type DeployedObject, type UpsertSpec } from '../../lib/fmc'
import { buildPortObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractPortGroupSpecs, buildPortGroupBaseFields, PORT_GROUPS_PATH } from './validate'

/** Deploy Port Groups: resolve each member name against the live Port Object index, then upsert with resolved refs. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const specs = extractPortGroupSpecs(ctx.canvas).filter((s) => s.name && s.memberNames.length > 0)
  const index = await buildPortObjectIndex(client)

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
      fields: { ...buildPortGroupBaseFields(spec), objects: resolved.map((r) => ({ id: r.id, type: r.type })) },
    })
  }

  if (unresolved.length > 0) {
    return {
      success: false,
      message:
        `Cannot deploy - some referenced port objects do not exist in FMC: ${unresolved.join('; ')}. ` +
        'Create them first (this app\'s Port Objects config type), or the name is only an ICMP object (not managed by this app - see README Coverage).',
    }
  }

  const rollback: DeployedObject[] = []
  const deployed: string[] = []
  try {
    await upsertByName(client, PORT_GROUPS_PATH, upsertSpecs, rollback, deployed)
    const activation = await deployToDevicesIfEnabled(client, settings)
    return {
      success: true,
      message: `Deployed ${deployed.length} port group(s) to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback, path: PORT_GROUPS_PATH },
    }
  } catch (error) {
    return {
      success: false,
      message: `Port group deploy failed after ${deployed.length} of ${upsertSpecs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback, path: PORT_GROUPS_PATH },
    }
  }
}
