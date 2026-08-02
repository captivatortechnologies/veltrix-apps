import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError, type TwingateClient } from '../../lib/twingateApi'
import {
  CREATE_SERVICE_ACCOUNT_MUTATION,
  LIST_SERVICE_ACCOUNTS_QUERY,
  UPDATE_SERVICE_ACCOUNT_MUTATION,
  assertMutationOk,
  buildCreateVariables,
  buildUpdateVariables,
  extractServiceAccountSpecs,
  serviceAccountKey,
  type LiveServiceAccount,
  type ServiceAccountCreateMutationResponse,
  type ServiceAccountUpdateMutationResponse,
} from './_shared'

const PAGE_SIZE = 200

export interface ServiceAccountRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveServiceAccount
}

/**
 * Deploy Twingate Service Accounts via the GraphQL API. Identity is the
 * account `name`: list the tenant's service accounts, match by name, then
 * update it (capturing its prior state for rollback) or create a new one.
 * Keys are out of scope — see `_shared.ts` header.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractServiceAccountSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServiceAccountRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listServiceAccounts(client)
    const byName = new Map(existing.filter((a) => a.name).map((a) => [serviceAccountKey(a.name as string), a]))

    for (const spec of specs) {
      const label = spec.name
      const key = serviceAccountKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        const liveId: string = live.id
        rollbackState.push({ key, label, existed: true, id: liveId, prior: live })
        const res = await client.graphql<ServiceAccountUpdateMutationResponse>(
          UPDATE_SERVICE_ACCOUNT_MUTATION,
          buildUpdateVariables(liveId, spec),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.serviceAccountUpdate),
          `update Service Account "${label}"`,
        )
      } else {
        const res = await client.graphql<ServiceAccountCreateMutationResponse>(
          CREATE_SERVICE_ACCOUNT_MUTATION,
          buildCreateVariables(spec),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.serviceAccountCreate),
          `create Service Account "${label}"`,
        )
        const id = res.data?.serviceAccountCreate?.entity?.id
        if (!id) throw new Error(`Service Account "${label}" was created but Twingate returned no id`)
        rollbackState.push({ key, label, existed: false, id })
        createdIds.push(id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Twingate Service Account(s) to ${graphqlUrl}: ${deployed.join(', ')}`,
      artifacts: { graphqlUrl, deployedServiceAccounts: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service Account deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, deployedServiceAccounts: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all Service Accounts; throws on error. */
export async function listServiceAccounts(client: TwingateClient): Promise<LiveServiceAccount[]> {
  const res = await client.listConnection<LiveServiceAccount>(LIST_SERVICE_ACCOUNTS_QUERY, 'serviceAccounts', PAGE_SIZE)
  if (res.error) throw new Error(`Failed to list Twingate Service Accounts: ${res.error}`)
  return res.nodes
}
