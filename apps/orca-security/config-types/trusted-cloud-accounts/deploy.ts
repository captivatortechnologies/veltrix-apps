import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { priorServerId, readPriorRollback } from '../../lib/reconcile'
import {
  accountFromReadEnvelope,
  accountFromWriteEnvelope,
  buildTrustedCloudAccountBody,
  type OrcaTrustedCloudAccount,
  type TrustedCloudAccountRollbackData,
  type TrustedCloudAccountRollbackEntry,
} from './_shared'

/**
 * Deploy Orca trusted cloud accounts over the REST API:
 *   read prior ids: ctx.platform.getLatestDeployment().rollbackData
 *   read (update/restore): GET  /api/organization/trusted_accounts?id={id}   -> { data: [ {...} ] } (ARRAY)
 *   create:                POST /api/organization/trusted_accounts           -> { data: { id } }    (single object)
 *   update:                PUT  /api/organization/trusted_accounts?id={id}
 *
 * The id travels as a QUERY PARAMETER on every operation but create — see
 * _shared.ts. Orca has no documented "list trusted accounts" endpoint, so
 * identity is the numeric account id this app ASSIGNS on create and PERSISTS
 * in rollbackData — recovered on the next deploy by the stable canvas item id
 * first (so a rename updates the same account) then by name.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const previousData = await readPriorRollback<OrcaTrustedCloudAccount>(ctx)

  const previous: TrustedCloudAccountRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const itemId = item.id ?? ''
      const name = String(item.fields.accountName ?? '').trim()
      if (!name) continue

      const knownId = priorServerId(previousData.previous, itemId, name)
      const prior = knownId ? await readTrustedAccount(client, knownId) : null

      if (knownId && prior) {
        const body = buildTrustedCloudAccountBody(item.fields, knownId)
        const res = await client.request<unknown>(
          'PUT',
          `/api/organization/trusted_accounts?id=${encodeURIComponent(knownId)}`,
          body,
        )
        if (res.error) throw new Error(`update trusted cloud account "${name}" failed: ${res.error}`)
        previous.push({ itemId, name, serverId: knownId, existed: true, prior })
      } else {
        const body = buildTrustedCloudAccountBody(item.fields)
        const res = await client.request<unknown>('POST', '/api/organization/trusted_accounts', body)
        if (res.error) throw new Error(`create trusted cloud account "${name}" failed: ${res.error}`)
        const created = accountFromWriteEnvelope(res.data)
        const newId = created?.id != null ? String(created.id) : null
        previous.push({ itemId, name, serverId: newId, existed: false, prior: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} trusted cloud account(s) to ${baseUrl}: ${applied.join(', ') || '(none)'}`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies TrustedCloudAccountRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Trusted cloud account deploy failed after ${applied.length} of ${items.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, applied },
      rollbackData: { previous } satisfies TrustedCloudAccountRollbackData,
    }
  }
}

/** GET one trusted account by id (query param), unwrapping the array read envelope. */
async function readTrustedAccount(client: OrcaClient, id: string): Promise<OrcaTrustedCloudAccount | null> {
  const res = await client.request<unknown>('GET', `/api/organization/trusted_accounts?id=${encodeURIComponent(id)}`)
  if (res.error) return null
  return accountFromReadEnvelope(res.data)
}
