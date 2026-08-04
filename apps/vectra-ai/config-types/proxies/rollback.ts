import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { addressOf, considerProxyOf, proxiesFromList, findProxy, idOfProxy, type VectraProxy } from './_shared'

/**
 * Undo a proxies deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH /proxies/<id> with the prior proxy state (restore), or — when the
 * proxy was newly created (prior null) — DELETE /proxies/<id> to remove it. Applied
 * over the Vectra Detect REST API (v2.5, 443).
 *
 * Vectra's own client carries an open caution (APP-15864): a PATCH update can change
 * the proxy's id as a side effect. So before restoring, this re-resolves the proxy's
 * CURRENT id by its (stable) address rather than trusting the id captured at deploy
 * time, falling back to the captured id only when the live re-lookup fails.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ address: string; proxyId: number | string | null; proxy: VectraProxy | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for proxy rollback' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { address, proxyId, proxy } of previous) {
      if (proxyId == null) {
        // A created proxy whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (proxy) {
        // Re-resolve the current id by address (APP-15864: a prior PATCH may have
        // changed it) — fall back to the captured id if the live list is unavailable.
        let currentId: number | string | null = proxyId
        try {
          const live = proxiesFromList(await getJson<unknown>(`${base}/proxies`, headers))
          const match = findProxy(live, address)
          if (match) currentId = idOfProxy(match) ?? proxyId
        } catch {
          // Best-effort — fall back to the id captured at deploy time.
        }

        const body = { proxy: { address: addressOf(proxy), considerProxy: considerProxyOf(proxy) } }
        await sendJson('PATCH', `${base}/proxies/${encodeURIComponent(String(currentId))}`, headers, body)
        restored++
      } else {
        await sendJson('DELETE', `${base}/proxies/${encodeURIComponent(String(proxyId))}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back proxies: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
