import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAdminClient, MISSING_CREDENTIAL_MESSAGE, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import { resolveClientByClientId } from '../../lib/clients'
import {
  deployPermissionItem,
  deployResourceItem,
  deployRolePolicyItem,
  deployScopeItem,
  isAuthorizationEnabled,
  type AuthorizationKind,
  type KeycloakAuthorizationRep,
} from './_shared'

/**
 * Deploy a client's authorization (resource-server) objects over the Admin
 * REST API. Each item targets an EXISTING client (by clientId) that must
 * already have authorization services enabled — this is checked once per
 * distinct client (GET {base} returning non-2xx means authz is not enabled)
 * and fails fast with an actionable message, mirroring cisco-meraki's
 * appliance-vlans "VLANs must be enabled on the network" precondition: this
 * app does not flip the switch for you, since enabling authorization also
 * requires the client to be confidential with service accounts enabled —
 * changes an operator should make deliberately.
 *
 * One item = one API call (resource/scope/permission/role-policy — see
 * ./_shared.ts's deploy*Item functions for the per-kind list/create/update
 * flow). The client UUID and authz-enabled checks are cached per clientId so
 * a canvas with many items on the same client only pays for them once.
 * rollbackData records, per item, the resolved client UUID (so rollback is
 * unaffected by a later client rename) and either the prior representation
 * (update) or nothing (create — rollback deletes it).
 */
interface PreviousEntry {
  clientId: string
  resolvedClientUuid: string
  kind: AuthorizationKind
  name: string
  id: string | null
  rep: KeycloakAuthorizationRep | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveGrant(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  const clientUuidCache = new Map<string, string>()
  const authzEnabledCache = new Map<string, boolean>()

  const previous: PreviousEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const clientId = readString(item.fields.clientId)
      const kind = readString(item.fields.kind) as AuthorizationKind
      const name = readString(item.fields.name)
      if (!clientId || !kind || !name) continue

      let clientUuid = clientUuidCache.get(clientId)
      if (!clientUuid) {
        const client = await resolveClientByClientId(admin, clientId)
        if (!client?.id) throw new Error(`client "${clientId}" not found`)
        clientUuid = client.id
        clientUuidCache.set(clientId, clientUuid)
      }

      if (!authzEnabledCache.has(clientUuid)) {
        authzEnabledCache.set(clientUuid, await isAuthorizationEnabled(admin, clientUuid))
      }
      if (!authzEnabledCache.get(clientUuid)) {
        throw new Error(
          `client "${clientId}" does not have authorization services enabled — enable "Authorization" on a ` +
            'confidential client with service accounts enabled first',
        )
      }

      let result
      switch (kind) {
        case 'resource':
          result = await deployResourceItem(admin, clientId, clientUuid, item.fields)
          break
        case 'scope':
          result = await deployScopeItem(admin, clientId, clientUuid, item.fields)
          break
        case 'permission':
          result = await deployPermissionItem(admin, clientId, clientUuid, item.fields)
          break
        case 'role-policy':
          result = await deployRolePolicyItem(admin, clientId, clientUuid, item.fields)
          break
        default:
          throw new Error(`unknown kind "${kind}" on client "${clientId}"`)
      }

      previous.push({ clientId, resolvedClientUuid: clientUuid, kind, name, id: result.id, rep: result.priorRep })
      applied.push(`${clientId}/${kind}/${name}`)
    }

    return {
      success: true,
      message: `Applied ${applied.length} authorization object(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Authorization deploy failed after ${applied.length} object(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
