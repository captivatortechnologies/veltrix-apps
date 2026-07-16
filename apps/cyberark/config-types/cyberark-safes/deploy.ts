import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCyberArkClient,
  cyberArkErrorMessage,
  encodeSafeUrlId,
  parseJson,
  type CyberArkClient,
} from '../../lib/cyberark'
import { extractSafeSpecs, safeKey, type LiveSafe, type SafeSpec } from './validate'

export interface SafeRollbackEntry {
  key: string
  label: string
  existed: boolean
  safeUrlId?: string
  prior?: LiveSafe
}

/**
 * Deploy CyberArk safes via the PVWA REST API.
 *
 * Identity is the safe name: list /Safes, match on the name, then PUT an existing
 * safe by its safeUrlId (partial update of the managed fields) or POST a new one.
 * The created/updated safe's safeUrlId is captured for path addressing + rollback.
 *
 * OLAC (Object Level Access Control) can be turned ON but not OFF once a safe
 * exists, so on UPDATE `olacEnabled` is only sent when enabling it.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractSafeSpecs(ctx.canvas).filter((s) => s.safeName && s.retentionCount !== null)
  const rollbackState: SafeRollbackEntry[] = []
  const createdSafeUrlIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listSafes(client)
    const byKey = new Map(
      existing.filter((s) => s.safeName).map((s) => [safeKey({ safeName: s.safeName as string }), s]),
    )

    for (const spec of specs) {
      const label = spec.safeName
      const key = safeKey(spec)
      const live = byKey.get(key)

      if (live) {
        const safeUrlId = live.safeUrlId ?? spec.safeName
        rollbackState.push({ key, label, existed: true, safeUrlId, prior: live })
        const res = await client.request('PUT', `/Safes/${encodeSafeUrlId(safeUrlId)}`, {
          body: buildBody(spec, { isUpdate: true }),
        })
        if (!res.ok) throw new Error(`Failed to update safe "${label}": ${cyberArkErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/Safes', { body: buildBody(spec, { isUpdate: false }) })
        if (!res.ok) throw new Error(`Failed to create safe "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<{ safeUrlId?: string; safeName?: string }>(res.body)
        const safeUrlId = created?.safeUrlId ?? created?.safeName ?? spec.safeName
        rollbackState.push({ key, label, existed: false, safeUrlId })
        createdSafeUrlIds.push(safeUrlId)
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} safe(s) to ${pvwaUrl}: ${deployed.join(', ')}`,
      artifacts: { pvwaUrl, deployedSafes: deployed },
      rollbackData: { previousState: rollbackState, createdSafeUrlIds },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Safe deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedSafes: deployed },
      rollbackData: { previousState: rollbackState, createdSafeUrlIds },
    }
  }
}

// --- Helpers ---

/** List all safes; throws on a non-OK response. */
export async function listSafes(client: CyberArkClient): Promise<LiveSafe[]> {
  const res = await client.getAll<LiveSafe>('/Safes')
  if (!res.ok) {
    throw new Error(`Failed to list safes: ${cyberArkErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}

/**
 * Build the /Safes request body. Exactly one retention field is set. On update,
 * olacEnabled is included only when enabling it (CyberArk cannot turn OLAC off).
 */
function buildBody(spec: SafeSpec, opts: { isUpdate: boolean }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    safeName: spec.safeName,
    description: spec.description,
    autoPurgeEnabled: spec.autoPurgeEnabled,
  }
  if (spec.location) body.location = spec.location
  if (spec.managingCpm) body.managingCPM = spec.managingCpm
  if (spec.retentionType === 'days') body.numberOfDaysRetention = spec.retentionCount
  else body.numberOfVersionsRetention = spec.retentionCount

  if (!opts.isUpdate) body.olacEnabled = spec.olacEnabled
  else if (spec.olacEnabled) body.olacEnabled = true

  return body
}
