import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import { accountsFromList, buildCreateBody, findFunctionalAccount, str, toPlatformId, type FunctionalAccount } from './_shared'

/**
 * Deploy Password Safe functional accounts over the BeyondInsight REST API inside
 * a PS-Auth session:
 *   read (identity): GET  /FunctionalAccounts          → match by (platform, domain, account)
 *   create:          POST /FunctionalAccounts          with the account body
 *
 * Password Safe has NO update (PUT) endpoint for functional accounts, so this is a
 * create-if-absent upsert: an account already present on its (platform, domain,
 * account) identity is left untouched and reported — changing it means delete +
 * recreate, which also loses the stored secret, so it is never done implicitly.
 *
 * rollbackData records, per account, whether WE created it and its assigned id, so
 * rollback can delete exactly the accounts this deploy added.
 *
 * NOTE: verify /FunctionalAccounts create + list against a live BeyondTrust instance.
 */
interface RollbackEntry {
  accountName: string
  platformId: number
  domainName: string
  functionalAccountId: number | string | null
  action: 'created' | 'existing'
}

async function listFunctionalAccounts(base: string, cookie: string): Promise<FunctionalAccount[]> {
  try {
    return accountsFromList(await getJson<unknown>(base, '/FunctionalAccounts', cookie))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for functional account deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const existing: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const live = await listFunctionalAccounts(base, cookie)

      for (const item of items) {
        const accountName = str(item.fields.accountName)
        const platformId = toPlatformId(item.fields.platformId)
        const domainName = str(item.fields.domainName)
        if (!accountName || platformId === null) continue

        const label = domainName ? `${domainName}\\${accountName}` : accountName
        const match = findFunctionalAccount(live, platformId, domainName, accountName)

        if (match && match.FunctionalAccountID != null) {
          existing.push(label)
          previous.push({ accountName, platformId, domainName, functionalAccountId: match.FunctionalAccountID, action: 'existing' })
          continue
        }

        const body = buildCreateBody(item.fields)
        const res = await sendJson<FunctionalAccount>('POST', base, '/FunctionalAccounts', cookie, body)
        created.push(label)
        previous.push({ accountName, platformId, domainName, functionalAccountId: res?.FunctionalAccountID ?? null, action: 'created' })
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (existing.length) parts.push(`${existing.length} already present (no update endpoint — delete & recreate to change)`)
    return {
      success: true,
      message: `Functional accounts: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Functional account deploy failed after ${created.length} created: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, existing },
      rollbackData: { previous },
    }
  }
}
