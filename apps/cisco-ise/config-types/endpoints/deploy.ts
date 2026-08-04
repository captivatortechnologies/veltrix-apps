import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  ersBase,
  buildErsResourceClient,
  readIseSettings,
  hasUsableCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type IseEndpoint,
  type EndPointGroup,
} from '../../lib/iseApi'
import { extractSpecs, toIseEndpointBody } from './_shared'

/**
 * Deploy endpoints over the ERS API:
 *   read (identity + rollback):  GET  /ers/config/endpoint?filter=mac.EQ.<mac>
 *   read (full prior detail):    GET  /ers/config/endpoint/{id}
 *   create:                      POST /ers/config/endpoint   (wrapper "ERSEndPoint")
 *   update:                      PUT  /ers/config/endpoint/{id}
 *
 * The MAC ADDRESS is the stable identity used to upsert (ERS filters by
 * `mac.EQ.`, not `name.EQ.` — see buildErsResourceClient's
 * `identityFilterField`). A `group_name` is resolved to its id via a live
 * lookup on the SAME EndPointGroup resource the endpoint-identity-groups
 * config type manages — an unresolvable name fails that item's deploy.
 */
export interface RollbackEntry {
  mac: string
  id: string | null
  endpoint: IseEndpoint | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasUsableCredential(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const settings = readIseSettings(ctx.settings)
  const base = ersBase(component, connectivity, connectivityProvider)
  const client = buildErsResourceClient<IseEndpoint>(base, 'endpoint', 'ERSEndPoint', credential, settings, { identityFilterField: 'mac' })
  const groupClient = buildErsResourceClient<EndPointGroup>(base, 'endpointgroup', 'EndPointGroup', credential, settings)

  const previous: RollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const spec = extractSpecs([item])[0]
      if (!spec.mac) continue

      let groupId: string | null = null
      if (spec.groupName) {
        const group = await groupClient.findByName(spec.groupName)
        if (!group) throw new Error(`Endpoint "${spec.mac}" references endpoint identity group "${spec.groupName}", which does not exist in ISE`)
        groupId = group.id
      }

      const existing = await client.findByName(spec.mac)
      if (existing) {
        const prior = await client.getById(existing.id)
        await client.update(existing.id, toIseEndpointBody(spec, groupId))
        previous.push({ mac: spec.mac, id: existing.id, endpoint: prior })
      } else {
        const newId = await client.create(toIseEndpointBody(spec, groupId))
        previous.push({ mac: spec.mac, id: newId, endpoint: null })
      }
      applied.push(spec.mac)
    }

    return {
      success: true,
      message: `Applied ${applied.length} endpoint(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Endpoint deploy failed after ${applied.length} endpoint(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
