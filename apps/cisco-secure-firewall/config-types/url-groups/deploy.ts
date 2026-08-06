import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, upsertByName, type DeployedObject, type UpsertSpec } from '../../lib/fmc'
import { buildUrlObjectIndex, resolveRefs } from '../../lib/fmcRefs'
import { extractUrlGroupSpecs, buildUrlGroupBaseFields, URL_GROUPS_PATH } from './validate'

/** Deploy URL Groups: resolve object-member names against the live URL Object index; literal members need no resolution. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const specs = extractUrlGroupSpecs(ctx.canvas).filter((s) => s.name && (s.urlObjectNames.length > 0 || s.literalUrls.length > 0))
  const index = await buildUrlObjectIndex(client)

  const upsertSpecs: UpsertSpec[] = []
  const unresolved: string[] = []
  for (const spec of specs) {
    const { resolved, missing } = resolveRefs(index, spec.urlObjectNames)
    if (missing.length > 0) {
      unresolved.push(`"${spec.name}": ${missing.join(', ')}`)
      continue
    }
    const fields = buildUrlGroupBaseFields(spec)
    if (resolved.length > 0) fields.objects = resolved.map((r) => ({ id: r.id }))
    upsertSpecs.push({ name: spec.name, fields })
  }

  if (unresolved.length > 0) {
    return {
      success: false,
      message:
        `Cannot deploy - some referenced URL objects do not exist in FMC: ${unresolved.join('; ')}. ` +
        'Create them first (this app\'s URL Objects config type) or fix the name.',
    }
  }

  const rollback: DeployedObject[] = []
  const deployed: string[] = []
  try {
    await upsertByName(client, URL_GROUPS_PATH, upsertSpecs, rollback, deployed)
    const activation = await deployToDevicesIfEnabled(client, settings)
    return {
      success: true,
      message: `Deployed ${deployed.length} URL group(s) to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback, path: URL_GROUPS_PATH },
    }
  } catch (error) {
    return {
      success: false,
      message: `URL group deploy failed after ${deployed.length} of ${upsertSpecs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback, path: URL_GROUPS_PATH },
    }
  }
}
