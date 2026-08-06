import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildFmcClient, deployToDevicesIfEnabled, upsertByName, type DeployedObject } from '../../lib/fmc'
import { extractNetworkObjectSpecs, buildNetworkObjectFields, pathForKind, type NetworkObjectSpec } from './validate'

/** A rollback entry needs its own `path` — unlike the flat object types, one canvas can span up to four endpoints. */
export interface NetworkObjectRollbackEntry extends DeployedObject {
  path: string
}

/**
 * Deploy network objects grouped by kind, since each kind is a distinct FMC
 * endpoint (see validate.ts's `pathForKind`). Each group is upserted with the
 * shared `upsertByName` primitive; a failure in one group still preserves the
 * rollback state accumulated so far, matching every other config type's
 * partial-failure handling in this app.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildFmcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, fmcUrl, settings } = built

  const specs = extractNetworkObjectSpecs(ctx.canvas).filter((s) => s.name && s.value)
  const byKind = new Map<string, NetworkObjectSpec[]>()
  for (const spec of specs) {
    const group = byKind.get(spec.kind) ?? []
    group.push(spec)
    byKind.set(spec.kind, group)
  }

  const rollback: NetworkObjectRollbackEntry[] = []
  const deployed: string[] = []

  try {
    for (const [kind, kindSpecs] of byKind) {
      const path = pathForKind(kind)
      const kindRollback: DeployedObject[] = []
      await upsertByName(
        client,
        path,
        kindSpecs.map((s) => ({ name: s.name, fields: buildNetworkObjectFields(s) })),
        kindRollback,
        deployed,
      )
      rollback.push(...kindRollback.map((entry) => ({ ...entry, path })))
    }

    const activation = await deployToDevicesIfEnabled(client, settings)
    return {
      success: true,
      message: `Deployed ${deployed.length} network object(s) to ${fmcUrl}. ${activation.message}`,
      artifacts: { fmcUrl, deployed, deployedToDevices: activation.triggered, deviceCount: activation.deviceCount },
      rollbackData: { rollback },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network object deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { fmcUrl, deployed },
      rollbackData: { rollback },
    }
  }
}
