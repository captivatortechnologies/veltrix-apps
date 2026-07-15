import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildZscalerClient,
  parseJson,
  zscalerErrorMessage,
  type ZscalerClient,
} from '../../lib/zscaler'
import {
  credentialIdentity,
  extractVpnCredentialSpecs,
  liveCredentialIdentity,
  type LiveVpnCredential,
  type VpnCredentialSpec,
} from './validate'

export interface VpnCredentialRollbackEntry {
  /** The credential's identity (fqdn/ip_address) — NEVER the secret. */
  identity: string
  /** false = deploy CREATED this credential (rollback deletes it). */
  existed: boolean
  id?: number
  /**
   * Prior NON-SECRET fields captured before an update, replayed on rollback.
   * ⚠ The write-only `preSharedKey` is DELIBERATELY absent — ZIA never returns
   * it, so it can be neither captured nor stored (see rollback.ts).
   */
  prior?: { type?: string; fqdn?: string; ipAddress?: string; comments?: string }
}

/**
 * Deploy ZIA VPN credentials via the Zscaler OneAPI.
 *
 * Identity is the fqdn (UFQDN) or ip_address (IP) — ZIA has no upsert: list
 * /vpnCredentials, match by identity, then PUT an existing credential or POST a
 * new one. ZIA STAGES every write — nothing takes effect until activation — so
 * this writes all credentials, then calls activate() ONCE at the end. If
 * activation fails the writes remain staged and rollbackData is returned so the
 * platform can revert them.
 *
 * ⚠ WRITE-ONLY SECRET: the `preSharedKey` is re-asserted on BOTH create and
 * update (it can never be read back to compare). It is NEVER captured into
 * rollbackData, artifacts or the message — only the non-secret identity is.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, vanity } = built

  const specs = extractVpnCredentialSpecs(ctx.canvas).filter((s) => s.type && credentialIdentity(s))
  const rollbackState: VpnCredentialRollbackEntry[] = []
  const createdIds: number[] = []
  const deployed: string[] = []

  try {
    const existing = await listVpnCredentials(client)
    const byIdentity = new Map<string, LiveVpnCredential>()
    for (const cred of existing) {
      const id = liveCredentialIdentity(cred)
      if (id) byIdentity.set(id.toLowerCase(), cred)
    }

    for (const spec of specs) {
      const identity = credentialIdentity(spec)
      const live = byIdentity.get(identity.toLowerCase())

      if (live && live.id != null) {
        // UPDATE — capture the prior NON-SECRET fields first (the PSK can't be
        // read back, so it is not captured).
        rollbackState.push({
          identity,
          existed: true,
          id: live.id,
          prior: {
            type: live.type,
            fqdn: live.fqdn,
            ipAddress: live.ipAddress,
            comments: live.comments ?? '',
          },
        })
        const res = await client.zia('PUT', `/vpnCredentials/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to update VPN credential "${identity}": ${zscalerErrorMessage(res)}`)
        }
      } else {
        const res = await client.zia('POST', '/vpnCredentials', { body: buildPayload(spec) })
        if (!res.ok) {
          throw new Error(`Failed to create VPN credential "${identity}": ${zscalerErrorMessage(res)}`)
        }
        const created = parseJson<LiveVpnCredential>(res.body)
        if (created?.id == null) {
          throw new Error(`VPN credential "${identity}" was created but the API returned no id`)
        }
        rollbackState.push({ identity, existed: false, id: created.id })
        createdIds.push(created.id)
      }

      deployed.push(identity)
    }

    // ZIA changes are staged — push them to production once, after all writes.
    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Staged ${deployed.length} ZIA VPN credential(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. The changes are saved but not active — re-run to retry activation.`,
        artifacts: { vanity, deployedCredentials: deployed },
        rollbackData: { previousState: rollbackState, createdIds },
      }
    }

    return {
      success: true,
      message: `Deployed and activated ${deployed.length} ZIA VPN credential(s) on tenant "${vanity}": ${deployed.join(
        ', ',
      )}`,
      artifacts: { vanity, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `VPN credential deployment failed after ${deployed.length} of ${specs.length} credential(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { vanity, deployedCredentials: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all ZIA VPN credentials; throws on a non-OK response. */
export async function listVpnCredentials(client: ZscalerClient): Promise<LiveVpnCredential[]> {
  const res = await client.ziaGetAll<LiveVpnCredential>('/vpnCredentials')
  if (!res.ok) {
    throw new Error(
      `Failed to list VPN credentials: ${zscalerErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

/** Find a VPN credential by identity (fqdn/ip_address); null when absent. */
export async function findVpnCredential(
  client: ZscalerClient,
  identity: string,
): Promise<LiveVpnCredential | null> {
  const all = await listVpnCredentials(client)
  const key = identity.toLowerCase()
  return all.find((c) => liveCredentialIdentity(c).toLowerCase() === key) ?? null
}

/**
 * Build the POST/PUT body for a credential. The identity field sent depends on
 * the type. ⚠ The `preSharedKey` is always re-asserted (write-only, so the
 * canvas is the source of truth every deploy) but never read back or diffed.
 */
function buildPayload(spec: VpnCredentialSpec): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: spec.type,
    // comments always sent (even empty) so clearing it converges the live credential.
    comments: spec.comments ?? '',
    preSharedKey: spec.preSharedKey, // ⚠ WRITE-ONLY SECRET
  }
  if (spec.type === 'UFQDN') body.fqdn = spec.fqdn
  else if (spec.type === 'IP') body.ipAddress = spec.ipAddress
  return body
}
