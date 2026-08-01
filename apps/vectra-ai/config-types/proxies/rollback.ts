import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, sendJson } from '../../lib/vectraApi'
import { addressOf, considerProxyOf, type VectraProxy } from './_shared'

/**
 * Undo a proxies deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH /proxies/<id> with the prior proxy state (restore), or — when the
 * proxy was newly created (prior null) — DELETE /proxies/<id> to remove it. Applied
 * over the Vectra Detect REST API (v2.5, 443). Verify against a live Vectra brain.
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
    for (const { proxyId, proxy } of previous) {
      if (proxyId == null) {
        // A created proxy whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (proxy) {
        const body = { proxy: { address: addressOf(proxy), considerProxy: considerProxyOf(proxy) } }
        await sendJson('PATCH', `${base}/proxies/${encodeURIComponent(String(proxyId))}`, headers, body)
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
