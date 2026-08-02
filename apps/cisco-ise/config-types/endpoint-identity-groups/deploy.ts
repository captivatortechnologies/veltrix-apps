import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildEndpointIdentityGroupsClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type EndPointGroup,
} from '../../lib/iseApi'
import { extractSpecs } from './_shared'

/**
 * Deploy endpoint identity groups over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/endpointgroup?filter=name.EQ.<name>
 *   read (full prior detail):    GET  /ers/config/endpointgroup/{id}
 *   create:                      POST /ers/config/endpointgroup
 *   update:                      PUT  /ers/config/endpointgroup/{id}
 *
 * The group NAME is the stable identity used to upsert. rollbackData records,
 * per group, its id AND the prior full resource (null when it did not exist) —
 * so rollback can restore the prior description or delete the one we created.
 *
 * Every group this app creates/updates is sent with systemDefined: false — ISE's
 * built-in groups are never touched (see the canvas template's module doc).
 */
export interface RollbackEntry {
  name: string
  id: string | null
  group: EndPointGroup | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildEndpointIdentityGroupsClient(base, credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.name) continue

      const existing = await client.findByName(spec.name)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, spec)
        previous.push({ name: spec.name, id: existing.id, group: prior })
      } else {
        const newId = await client.create(spec)
        previous.push({ name: spec.name, id: newId, group: null })
      }
      applied.push(spec.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} endpoint identity group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Endpoint identity group deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
