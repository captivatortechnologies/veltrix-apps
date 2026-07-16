import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildWizClient, graphqlErrorMessage, type WizClient } from '../../lib/wiz'
import { accountKey, extractServiceAccountSpecs, type LiveServiceAccount } from './validate'

// --- GraphQL operations (verified against the Wiz schema) --------------------

/**
 * List service accounts (Relay connection). Wiz caps the service-account page
 * size at 60. Only the fields needed for name-matching + drift are selected —
 * the client SECRET is a write-only output and is never listed.
 */
export const LIST_SERVICE_ACCOUNTS_QUERY = `
query ListServiceAccounts($first: Int, $after: String) {
  serviceAccounts(first: $first, after: $after) {
    nodes {
      id
      name
      type
      scopes
      clientId
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`

/**
 * Create a service account. The mutation returns the generated client SECRET
 * ONCE — this selection set deliberately OMITS `clientSecret` so the secret is
 * never received, stored, diffed, or logged by the pipeline. Only the
 * non-sensitive clientId is read back for operator reference.
 */
const CREATE_SERVICE_ACCOUNT_MUTATION = `
mutation CreateServiceAccount($input: CreateServiceAccountInput!) {
  createServiceAccount(input: $input) {
    serviceAccount {
      id
      name
      clientId
      scopes
      type
    }
  }
}`

const PAGE_SIZE = 60

export interface ServiceAccountRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
}

interface CreateServiceAccountResult {
  createServiceAccount?: { serviceAccount?: LiveServiceAccount }
}

/**
 * Deploy Wiz service accounts via the GraphQL API.
 *
 * Identity is the account `name`: list the tenant's service accounts, match on
 * the name, and create any that are missing. Existing accounts are left
 * untouched — a service account is immutable through this config type because
 * its client secret is generated once at creation and cannot be re-read, so
 * re-creating or mutating it would be destructive. Created account ids are
 * captured for rollback; the generated secret is never captured.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, graphqlUrl } = built

  const specs = extractServiceAccountSpecs(ctx.canvas).filter((s) => s.name)
  const rollbackState: ServiceAccountRollbackEntry[] = []
  const createdIds: string[] = []
  const created: string[] = []
  const skipped: string[] = []
  const createdClientIds: Record<string, string> = {}

  try {
    const existing = await listServiceAccounts(client)
    const byName = new Map(existing.filter((a) => a.name).map((a) => [accountKey(a.name as string), a]))

    for (const spec of specs) {
      const label = spec.name
      const key = accountKey(spec.name)
      const live = byName.get(key)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id })
        skipped.push(label)
        continue
      }

      const input: Record<string, unknown> = {
        name: spec.name,
        type: spec.type,
        scopes: spec.scopes,
      }
      if (spec.assignedProjectIds.length > 0) input.assignedProjectIds = spec.assignedProjectIds

      const res = await client.graphql<CreateServiceAccountResult>(CREATE_SERVICE_ACCOUNT_MUTATION, { input })
      if (res.transportError) throw new Error(`Failed to create service account "${label}": ${res.transportError}`)
      if (res.errors) throw new Error(`Failed to create service account "${label}": ${graphqlErrorMessage(res.errors)}`)

      const account = res.data?.createServiceAccount?.serviceAccount
      if (!account?.id) throw new Error(`Service account "${label}" was created but Wiz returned no id`)

      rollbackState.push({ key, label, existed: false, id: account.id })
      createdIds.push(account.id)
      created.push(label)
      if (account.clientId) createdClientIds[label] = account.clientId
    }

    const summary =
      `Reconciled ${specs.length} Wiz service account(s) on ${graphqlUrl}: ` +
      `${created.length} created, ${skipped.length} already present.`

    return {
      success: true,
      message: created.length
        ? `${summary} The generated client secret(s) are shown only once by Wiz and are intentionally not captured here — rotate the secret in Wiz to obtain a usable value.`
        : summary,
      artifacts: {
        graphqlUrl,
        createdAccounts: created,
        skippedAccounts: skipped,
        // Non-sensitive client ids only; the client secret is never captured.
        createdClientIds,
      },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Service account deployment failed after creating ${created.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { graphqlUrl, createdAccounts: created, skippedAccounts: skipped },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers -----------------------------------------------------------------

/** List all service accounts in the tenant; throws on a transport/GraphQL error. */
export async function listServiceAccounts(client: WizClient): Promise<LiveServiceAccount[]> {
  const res = await client.listConnection<LiveServiceAccount>(
    LIST_SERVICE_ACCOUNTS_QUERY,
    'serviceAccounts',
    PAGE_SIZE,
  )
  if (res.error) throw new Error(`Failed to list Wiz service accounts: ${res.error}`)
  return res.nodes
}
