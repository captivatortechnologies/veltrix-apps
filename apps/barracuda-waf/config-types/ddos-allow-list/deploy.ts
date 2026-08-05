import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient, barracudaErrorMessage, type BarracudaWaasClient } from '../../lib/barracudaWaf'
import {
  allowListKey,
  buildAllowListBody,
  extractDdosAllowListSpecs,
  listAllowList,
  type DdosAllowListSpec,
  type LiveAllowListEntry,
} from './validate'

export type AllowListRollbackEntry =
  | { action: 'created'; ip: string; id: string }
  | { action: 'updated'; ip: string; id: string; prior: LiveAllowListEntry }
  | { action: 'deleted'; ip: string; prior: LiveAllowListEntry }

export interface DdosAllowListRollbackData {
  entries: AllowListRollbackEntry[]
}

/** Path to a single allow-list entry by its server-assigned id. */
export function allowListItemPath(client: BarracudaWaasClient, appName: string, id: string | number): string {
  return `${client.appPath(appName)}/ddos/allow_list/${encodeURIComponent(String(id))}/`
}

/**
 * Deploy the Application's DDoS allow list via /applications/{appName}/ddos/allow_list/.
 *
 * This config type OWNS the allow list: the canvas is the complete desired
 * set, reconciled by IP address. Existing entries not declared are removed;
 * declared entries not yet present are created (POST); declared entries that
 * already exist are updated (PATCH) even when unchanged, so any out-of-band
 * edit (note, allow_bypass) is corrected. Every touched entry's prior state is
 * captured so rollback can restore it exactly.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, baseUrl, appName } = built

  const specs = extractDdosAllowListSpecs(ctx.canvas).filter((s) => s.ip)
  const rollback: AllowListRollbackEntry[] = []
  let created = 0
  let updated = 0
  let removed = 0

  try {
    const existing = await listAllowList(client, appName)
    const byKey = new Map(existing.filter((e) => e.ip).map((e) => [allowListKey(e.ip as string), e]))
    const declaredKeys = new Set(specs.map((s) => allowListKey(s.ip)))

    for (const spec of specs) {
      const key = allowListKey(spec.ip)
      const live = byKey.get(key)
      const body = buildAllowListBody(spec)

      if (live?.id !== undefined) {
        rollback.push({ action: 'updated', ip: spec.ip, id: String(live.id), prior: live })
        const res = await client.request('PATCH', allowListItemPath(client, appName, live.id), { body })
        if (!res.ok) throw new Error(`Failed to update allow-list entry "${spec.ip}": ${barracudaErrorMessage(res)}`)
        updated++
      } else {
        const res = await client.request('POST', `${client.appPath(appName)}/ddos/allow_list/`, { body })
        if (!res.ok) throw new Error(`Failed to create allow-list entry "${spec.ip}": ${barracudaErrorMessage(res)}`)
        const createdId = readCreatedId(res.body)
        if (createdId) rollback.push({ action: 'created', ip: spec.ip, id: createdId })
        created++
      }
    }

    for (const entry of existing) {
      if (!entry.ip || entry.id === undefined) continue
      if (declaredKeys.has(allowListKey(entry.ip))) continue
      rollback.push({ action: 'deleted', ip: entry.ip, prior: entry })
      const res = await client.request('DELETE', allowListItemPath(client, appName, entry.id as string | number))
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to remove undeclared allow-list entry "${entry.ip}": ${barracudaErrorMessage(res)}`)
      }
      removed++
    }

    return {
      success: true,
      message: `Deployed DDoS allow list to Application "${appName}": ${created} created, ${updated} updated, ${removed} removed.`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies DdosAllowListRollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `DDoS allow list deployment failed after ${created + updated} upsert(s), ${removed} removal(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { baseUrl, appName, created, updated, removed },
      rollbackData: { entries: rollback } satisfies DdosAllowListRollbackData,
    }
  }
}

function readCreatedId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>
    if (parsed.id !== undefined) return String(parsed.id)
    return undefined
  } catch {
    return undefined
  }
}

// Re-exported so rollback/driftDetect/healthCheck don't need their own import of the spec type.
export type { DdosAllowListSpec }
