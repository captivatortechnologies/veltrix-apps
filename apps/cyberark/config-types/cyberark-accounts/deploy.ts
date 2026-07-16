import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  parseJson,
  parseJsonObject,
  type CyberArkClient,
} from '../../lib/cyberark'
import { accountKey, extractAccountSpecs, type AccountSpec, type LiveAccount } from './validate'

/**
 * Rollback state for one account. `prior` carries ONLY non-secret fields — the
 * write-only password is never read back or stored, so a restored account keeps
 * whatever secret it already had.
 */
export interface AccountRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
  prior?: {
    address?: string
    userName?: string
    automaticManagementEnabled?: boolean
    manualManagementReason?: string
    platformAccountProperties?: Record<string, unknown>
  }
}

/**
 * Deploy CyberArk accounts via the PVWA REST API.
 *
 * Identity is (account name, safe name): search /Accounts, match on name + safe,
 * then PATCH an existing account (op/path/value) or POST a new one.
 *
 * ⚠ SECRET: the password / key is WRITE-ONLY and sent ONLY on create. It is never
 * read back, diffed, or stored in rollbackData / artifacts / error messages. To
 * rotate an existing account's secret, use CyberArk's change-password workflow —
 * this app does not manage secret rotation.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractAccountSpecs(ctx.canvas).filter((s) => s.name && s.safeName && s.platformId)
  const rollbackState: AccountRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const label = `${spec.name} @ ${spec.safeName}`
      const key = accountKey(spec)
      const live = await findAccount(client, spec)

      if (live && live.id) {
        rollbackState.push({ key, label, existed: true, id: live.id, prior: priorNonSecret(live) })
        const ops = buildPatchOps(spec, live)
        if (ops.length > 0) {
          const res = await client.request('PATCH', `/Accounts/${encodeURIComponent(live.id)}`, { body: ops })
          if (!res.ok) throw new Error(`Failed to update account "${label}": ${cyberArkErrorMessage(res)}`)
        }
      } else {
        const res = await client.request('POST', '/Accounts', { body: buildCreateBody(spec) })
        if (!res.ok) throw new Error(`Failed to create account "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<{ id?: string }>(res.body)
        if (!created?.id) throw new Error(`Account "${label}" was created but the API returned no id`)
        rollbackState.push({ key, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} account(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      // artifacts carry names only — never the secret or account contents.
      artifacts: { pvwaUrl, deployedAccounts: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Account deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedAccounts: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** Find an account by (name, safe). Searches by name, then matches in code. */
export async function findAccount(client: CyberArkClient, spec: { name: string; safeName: string }): Promise<LiveAccount | null> {
  const res = await client.getAll<LiveAccount>('/Accounts', { search: spec.name })
  if (!res.ok) {
    throw new Error(`Failed to search accounts for "${spec.name}": ${cyberArkErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  const name = spec.name.toLowerCase()
  const safe = spec.safeName.toLowerCase()
  return (
    res.items.find((a) => (a.name ?? '').toLowerCase() === name && (a.safeName ?? '').toLowerCase() === safe) ?? null
  )
}

/**
 * Build the POST /Accounts body. The write-only secret is included ONLY when the
 * user supplied one (otherwise the CPM / manual workflow provisions it). This is
 * the only place the secret is ever sent.
 */
function buildCreateBody(spec: AccountSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    safeName: spec.safeName,
    platformId: spec.platformId,
    secretType: spec.secretType,
    platformAccountProperties: parseJsonObject(spec.platformPropertiesJson).value ?? {},
    secretManagement: buildSecretManagement(spec),
  }
  if (spec.address) body.address = spec.address
  if (spec.userName) body.userName = spec.userName
  if (spec.secret) body.secret = spec.secret // ⚠ write-only — create only
  return body
}

/** secretManagement block; a manual reason is only sent when management is off. */
function buildSecretManagement(spec: AccountSpec): Record<string, unknown> {
  const mgmt: Record<string, unknown> = { automaticManagementEnabled: spec.automaticManagementEnabled }
  if (!spec.automaticManagementEnabled && spec.manualManagementReason) {
    mgmt.manualManagementReason = spec.manualManagementReason
  }
  return mgmt
}

/**
 * Build a JSON-Patch op list for the managed, NON-SECRET fields that differ from
 * the live account. The secret is never included. Returns [] when nothing changed.
 */
function buildPatchOps(spec: AccountSpec, live: LiveAccount): Array<{ op: string; path: string; value: unknown }> {
  const ops: Array<{ op: string; path: string; value: unknown }> = []

  if (spec.address && spec.address !== (live.address ?? '')) {
    ops.push({ op: 'replace', path: '/address', value: spec.address })
  }
  if (spec.userName && spec.userName !== (live.userName ?? '')) {
    ops.push({ op: 'replace', path: '/userName', value: spec.userName })
  }
  const liveAuto = live.secretManagement?.automaticManagementEnabled ?? true
  if (liveAuto !== spec.automaticManagementEnabled) {
    ops.push({ op: 'replace', path: '/secretManagement/automaticManagementEnabled', value: spec.automaticManagementEnabled })
    if (!spec.automaticManagementEnabled && spec.manualManagementReason) {
      ops.push({ op: 'replace', path: '/secretManagement/manualManagementReason', value: spec.manualManagementReason })
    }
  }
  const desiredProps = parseJsonObject(spec.platformPropertiesJson).value ?? {}
  const liveProps = live.platformAccountProperties ?? {}
  for (const [propKey, value] of Object.entries(desiredProps)) {
    if (JSON.stringify(liveProps[propKey]) !== JSON.stringify(value)) {
      // `add` upserts a platform property (replace fails if it is not yet set).
      ops.push({ op: 'add', path: `/platformAccountProperties/${propKey}`, value })
    }
  }
  return ops
}

/** Capture a live account's non-secret fields for rollback (never the secret). */
function priorNonSecret(live: LiveAccount): AccountRollbackEntry['prior'] {
  return {
    address: live.address,
    userName: live.userName,
    automaticManagementEnabled: live.secretManagement?.automaticManagementEnabled,
    manualManagementReason: live.secretManagement?.manualManagementReason,
    platformAccountProperties: live.platformAccountProperties,
  }
}
