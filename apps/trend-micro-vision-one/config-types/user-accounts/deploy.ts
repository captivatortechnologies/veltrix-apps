import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient, visionOneWriteError, type VisionOneClient } from '../../lib/visionOneApi'
import {
  ACCOUNT_ENDPOINTS,
  accountIdFromResponse,
  accountItemPath,
  accountsFromResponse,
  buildInviteBody,
  buildUpdateBody,
  findAccountByEmail,
  parseAccountFields,
  type UserAccount,
} from './_shared'

/**
 * Deploy Trend Vision One IAM user accounts over the public REST API, reconciled
 * BY EMAIL (the config-as-code identity):
 *   list:   GET   /iam/accounts                → identity match
 *   invite: POST  /iam/accounts                → new account (pending acceptance)
 *   update: PATCH /iam/accounts/{id}            → role / status / description
 *
 * The invite endpoint does not accept `status` (a new account's initial status is
 * controlled by Vision One), so only role/authType/description are sent on
 * create; update sends role/status/description (authType cannot be changed once
 * an account exists). When the invite response does not carry the new account's
 * id, this falls back to re-listing and matching by email so rollback can still
 * target it for delete.
 *
 * rollbackData.previous carries every change made (prior role/status/description
 * for accounts we UPDATED, the new id for accounts we INVITED) so rollback can
 * fully undo a partial deploy.
 */

export interface AccountRollbackEntry {
  email: string
  /** Prior state when we UPDATED an existing account (restore target); null when we INVITED it. */
  prior: { id: string; role: string; status: string; description: string } | null
  /** Id assigned when we INVITED a new account (delete target); null when unresolved or we updated. */
  createdId: string | null
}

/** Best-effort read of the live account list for identity matching. */
async function listAccounts(client: VisionOneClient): Promise<UserAccount[]> {
  try {
    const res = await client.get(ACCOUNT_ENDPOINTS.list)
    if (!res.ok) return []
    return accountsFromResponse(res.json)
  } catch {
    return []
  }
}

/** Re-list and match by email when an invite response did not carry the new id. */
async function resolveCreatedId(client: VisionOneClient, email: string): Promise<string | null> {
  const live = await listAccounts(client)
  return findAccountByEmail(live, email)?.id ?? null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, settings, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for user-account deployment' }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previous: AccountRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = await listAccounts(client)

    for (const item of items) {
      const account = parseAccountFields(item.fields)
      if (!account) continue

      const match = findAccountByEmail(live, account.email)

      if (match?.id) {
        const res = await client.patch(accountItemPath(match.id), buildUpdateBody(account))
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `User-account deploy failed updating ${account.email}: ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        previous.push({
          email: account.email,
          prior: {
            id: match.id,
            role: String(match.role ?? ''),
            status: String(match.status ?? 'enabled'),
            description: String(match.description ?? ''),
          },
          createdId: null,
        })
      } else {
        const res = await client.post(ACCOUNT_ENDPOINTS.invite, buildInviteBody(account))
        const error = visionOneWriteError(res)
        if (error) {
          return {
            success: false,
            message: `User-account deploy failed inviting ${account.email}: ${error}`,
            artifacts: { applied },
            rollbackData: { previous },
          }
        }
        const createdId = accountIdFromResponse(res.json) ?? (await resolveCreatedId(client, account.email))
        previous.push({ email: account.email, prior: null, createdId })
      }

      applied.push(account.email)
    }

    if (applied.length === 0) {
      return { success: true, message: 'No user accounts to apply.', artifacts: { applied: [] }, rollbackData: { previous: [] } }
    }

    return {
      success: true,
      message: `Applied ${applied.length} user account(s): ${applied.join(', ')}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User-account deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
