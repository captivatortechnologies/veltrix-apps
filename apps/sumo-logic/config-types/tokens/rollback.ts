import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildTokenUpdateBody, findToken, tokensFromList, type Token } from './_shared'

/**
 * Undo a tokens deploy from rollbackData.previous (written by deploy()): for
 * each entry, re-read the CURRENT live token list (update is optimistic-
 * concurrency versioned — the version captured before our own update is now
 * stale) then PUT the prior name/description/status with the fresh version
 * (restore), or — when the token was newly created (prior body null) — DELETE
 * it. Applied over the Sumo Logic Management API.
 *
 * API: https://help.sumologic.com/docs/api/tokens-library-token-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; tokenId: string | null; token: Token | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for token rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    let live: Token[] | null = null
    for (const { tokenId, token } of previous) {
      if (tokenId == null) {
        // A created token whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/tokens/${encodeURIComponent(tokenId)}`
      if (token) {
        if (!live) live = tokensFromList(await getJson<unknown>(`${base}/tokens`, headers))
        const current = findToken(live, token.name) ?? { version: 0 }
        await sendJson('PUT', path, headers, buildTokenUpdateBody(token, current.version ?? 0))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back tokens: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
