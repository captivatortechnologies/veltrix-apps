import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type AllowedProtocols,
} from '../../lib/iseApi'
import { extractSpecs, toAllowedProtocolsBody } from './_shared'

/**
 * Deploy Allowed Protocols services over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/allowedprotocols?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/allowedprotocols/{id}
 *   create:                      POST /ers/config/allowedprotocols
 *   update:                      PUT  /ers/config/allowedprotocols/{id}
 *
 * The service NAME is the stable identity used to upsert. Only the top-level
 * flags this app manages are sent — see the module doc / README for the
 * nested eapFast/eapTls/eapTtls/peap/teap sub-objects intentionally left
 * untouched (an update never clears them; ERS merges the top-level fields we
 * send with whatever nested configuration already exists).
 */
export interface RollbackEntry {
  name: string
  id: string | null
  service: AllowedProtocols | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<AllowedProtocols>(base, 'allowedprotocols', 'Allowedprotocols', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toAllowedProtocolsBody(spec))
        previous.push({ name: spec.name, id: existing.id, service: prior })
      } else {
        const newId = await client.create(toAllowedProtocolsBody(spec))
        previous.push({ name: spec.name, id: newId, service: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Allowed Protocols service(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Allowed Protocols deploy failed after ${applied.length} service(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
