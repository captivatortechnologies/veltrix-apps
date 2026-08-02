import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type NetworkDevice,
} from '../../lib/iseApi'
import { extractSpecs, toNetworkDeviceBody, stripSecrets } from './_shared'

/**
 * Deploy network devices over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/networkdevice?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/networkdevice/{id}
 *   create:                      POST /ers/config/networkdevice
 *   update:                      PUT  /ers/config/networkdevice/{id}
 *
 * The device NAME is the stable identity used to upsert. rollbackData records,
 * per device, its id AND the prior resource with any secret-shaped field
 * stripped (null when it did not exist) — so rollback can restore the prior
 * non-secret fields or delete the one we created.
 *
 * ⚠ WRITE-ONLY SECRET: the RADIUS shared secret can never be read back from
 * ISE, so it is sent ONLY when the canvas field is non-blank, is never
 * captured into rollbackData/artifacts/logs, and is never drift-checked (see
 * driftDetect.ts and this config type's module docs).
 */
export interface RollbackEntry {
  name: string
  id: string | null
  device: NetworkDevice | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<NetworkDevice>(base, 'networkdevice', 'NetworkDevice', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name || spec.ipEntries.length === 0) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toNetworkDeviceBody(spec))
        previous.push({ name: spec.name, id: existing.id, device: prior ? stripSecrets(prior) : null })
      } else {
        const newId = await client.create(toNetworkDeviceBody(spec))
        previous.push({ name: spec.name, id: newId, device: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} network device(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Network device deploy failed after ${applied.length} device(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
