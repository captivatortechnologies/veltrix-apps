import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { cyberArkErrorMessage, parseCollectionArray, parseJson, buildCyberArkClient, type CyberArkClient } from '../../lib/cyberark'
import { extractAllowedReferrerSpecs, referrerKey, type LiveAllowedReferrer } from './validate'

/** Rollback state for one referrer entry created by this deploy. */
export interface AllowedReferrerRollbackEntry {
  key: string
  label: string
  existed: boolean
  id?: string
}

/**
 * Deploy CyberArk allowed referrers via the PVWA Gen2 REST API.
 *
 * ⚠ CREATE-ONLY: list .../AllowedReferrers, match by URL, POST any entry
 * that's missing. There is no verified update/delete endpoint for a single
 * entry, so an existing entry whose "regularExpression" flag differs from
 * the desired value is left AS-IS and reported informationally rather than
 * attempted (see driftDetect.ts) — this app never guesses at an unverified
 * write path.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, pvwaUrl } = built

  const specs = extractAllowedReferrerSpecs(ctx.canvas).filter((s) => s.referrerUrl)
  const rollbackState: AllowedReferrerRollbackEntry[] = []
  const deployed: string[] = []
  const notes: string[] = []

  try {
    const byKey = await mapReferrers(client)

    for (const spec of specs) {
      const label = spec.referrerUrl
      const key = referrerKey(spec)
      const live = byKey.get(key)

      if (!live) {
        const res = await client.request('POST', '/Configuration/AccessRestriction/AllowedReferrers', {
          body: { referrerURL: spec.referrerUrl, regularExpression: spec.regularExpression },
        })
        if (!res.ok) throw new Error(`Failed to add allowed referrer "${label}": ${cyberArkErrorMessage(res)}`)
        const created = parseJson<LiveAllowedReferrer>(res.body) ?? undefined
        rollbackState.push({ key, label, existed: false, id: readReferrerId(created) })
      } else {
        rollbackState.push({ key, label, existed: true, id: readReferrerId(live) })
        const liveRegex = live.regularExpression === true || live.regularExpression === 'true'
        if (liveRegex !== spec.regularExpression) {
          notes.push(`Allowed referrer "${label}" already exists with regularExpression=${liveRegex} — cannot be changed (no verified update endpoint); "${spec.regularExpression}" was not applied`)
        }
      }
      deployed.push(label)
    }

    await client.logoff()
    return {
      success: true,
      message: `Deployed ${deployed.length} allowed referrer(s) to ${pvwaUrl}: ${deployed.join(', ')}${notes.length ? ` (${notes.length} note(s))` : ''}`,
      artifacts: { pvwaUrl, deployedReferrers: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    await client.logoff()
    return {
      success: false,
      message: `Allowed referrer deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { pvwaUrl, deployedReferrers: deployed, notes },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/** List all allowed referrers; throws on a non-OK response. */
export async function listReferrers(client: CyberArkClient): Promise<LiveAllowedReferrer[]> {
  const res = await client.request('GET', '/Configuration/AccessRestriction/AllowedReferrers')
  if (!res.ok) throw new Error(`Failed to list allowed referrers: ${cyberArkErrorMessage(res)}`)
  return parseCollectionArray<LiveAllowedReferrer>(res.body, ['value', 'AllowedReferrers'])
}

/** Index allowed referrers by their natural key (URL, lower-cased). */
export async function mapReferrers(client: CyberArkClient): Promise<Map<string, LiveAllowedReferrer>> {
  const referrers = await listReferrers(client)
  return new Map(referrers.filter((r) => typeof r.referrerURL === 'string' && r.referrerURL).map((r) => [referrerKey({ referrerUrl: r.referrerURL as string }), r]))
}

/** Read whichever id field the live entry carries — the exact field name is not independently confirmed. */
function readReferrerId(entry: LiveAllowedReferrer | undefined): string | undefined {
  const id = entry?.id ?? entry?.ReferrerID
  return id !== undefined ? String(id) : undefined
}
