import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildPasswordSafeUrl, getJson, sendJson, withSession } from '../../lib/beyondtrustApi'
import {
  buildAccountBody,
  findManagedAccount,
  findManagedSystemByName,
  listFrom,
  str,
  type ManagedAccount,
  type ManagedSystemRef,
} from './_shared'

/**
 * Deploy Password Safe managed accounts over the BeyondInsight REST API inside
 * a PS-Auth session, scoped to an EXISTING managed system (resolved by name):
 *   resolve parent:  GET  /ManagedSystems                              → match by SystemName
 *   read (identity): GET  /ManagedSystems/{systemId}/ManagedAccounts    → match by (account, domain)
 *   create:          POST /ManagedSystems/{systemId}/ManagedAccounts   with the account body (AutoManagementFlag: true)
 *   update:          PUT  /ManagedAccounts/{id}                        with the account body
 *
 * Unlike functional-accounts/user-groups/workgroups, Password Safe DOES expose
 * an update endpoint for a managed account — this is a REAL upsert. rollbackData
 * records, per account, the id and the FULL prior representation for one we
 * updated (so rollback can restore it), or null for one we created (so
 * rollback deletes it) — same shape as the Keycloak app's protocol-mappers
 * config type.
 *
 * NOTE: verify /ManagedSystems/{id}/ManagedAccounts create + /ManagedAccounts
 * update against a live BeyondTrust instance.
 */
interface RollbackEntry {
  systemName: string
  accountName: string
  domainName: string
  managedAccountId: number | string | null
  previous: ManagedAccount | null
}

async function listManagedSystems(base: string, cookie: string): Promise<ManagedSystemRef[]> {
  try {
    return listFrom<ManagedSystemRef>(await getJson<unknown>(base, '/ManagedSystems', cookie))
  } catch {
    return []
  }
}

async function listAccounts(base: string, cookie: string, systemId: number | string): Promise<ManagedAccount[]> {
  try {
    return listFrom<ManagedAccount>(
      await getJson<unknown>(base, `/ManagedSystems/${encodeURIComponent(String(systemId))}/ManagedAccounts`, cookie),
    )
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for managed account deployment' }
  }

  const base = buildPasswordSafeUrl(component, connectivity, connectivityProvider)
  const previous: RollbackEntry[] = []
  const created: string[] = []
  const updated: string[] = []

  try {
    await withSession(base, credential, async (cookie) => {
      const systems = await listManagedSystems(base, cookie)

      for (const item of items) {
        const systemName = str(item.fields.systemName)
        const accountName = str(item.fields.accountName)
        const domainName = str(item.fields.domainName)
        if (!systemName || !accountName) continue

        const system = findManagedSystemByName(systems, systemName)
        if (!system?.ManagedSystemID) {
          throw new Error(
            `Managed system "${systemName}" was not found — create it first via the Managed Systems config type, or verify the name.`,
          )
        }

        const label = domainName ? `${systemName}/${domainName}\\${accountName}` : `${systemName}/${accountName}`
        const live = await listAccounts(base, cookie, system.ManagedSystemID)
        const match = findManagedAccount(live, accountName, domainName)
        const body = buildAccountBody(item.fields)

        if (match?.ManagedAccountID != null) {
          const res = await sendJson<ManagedAccount>('PUT', base, `/ManagedAccounts/${encodeURIComponent(String(match.ManagedAccountID))}`, cookie, body)
          updated.push(label)
          previous.push({ systemName, accountName, domainName, managedAccountId: res?.ManagedAccountID ?? match.ManagedAccountID, previous: match })
        } else {
          const res = await sendJson<ManagedAccount>(
            'POST',
            base,
            `/ManagedSystems/${encodeURIComponent(String(system.ManagedSystemID))}/ManagedAccounts`,
            cookie,
            body,
          )
          created.push(label)
          previous.push({ systemName, accountName, domainName, managedAccountId: res?.ManagedAccountID ?? null, previous: null })
        }
      }
    })

    const parts: string[] = []
    if (created.length) parts.push(`${created.length} created`)
    if (updated.length) parts.push(`${updated.length} updated`)
    return {
      success: true,
      message: `Managed accounts: ${parts.join(', ') || '(none)'}`,
      artifacts: { created, updated },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Managed account deploy failed after ${created.length} created, ${updated.length} updated: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { created, updated },
      rollbackData: { previous },
    }
  }
}
