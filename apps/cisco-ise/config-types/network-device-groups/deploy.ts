import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetworkDeviceGroup,
} from '../../lib/iseApi'
import { extractSpecs, toNetworkDeviceGroupBody } from './_shared'

/**
 * Deploy network device groups over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/networkdevicegroup?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/networkdevicegroup/{id}
 *   create:                      POST /ers/config/networkdevicegroup
 *   update:                      PUT  /ers/config/networkdevicegroup/{id}
 *
 * The group NAME (its full "#"-path) is the stable identity used to upsert.
 * rollbackData records, per group, its id AND the prior full resource (null
 * when it did not exist) — so rollback can restore the prior description or
 * delete the one we created.
 */
export interface RollbackEntry {
  name: string
  id: string | null
  group: NetworkDeviceGroup | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<NetworkDeviceGroup>(base, 'networkdevicegroup', 'NetworkDeviceGroup', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toNetworkDeviceGroupBody(spec))
        previous.push({ name: spec.name, id: existing.id, group: prior })
      } else {
        const newId = await client.create(toNetworkDeviceGroupBody(spec))
        previous.push({ name: spec.name, id: newId, group: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} network device group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network device group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
