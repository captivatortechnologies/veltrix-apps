import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildTokenCreateBody, buildTokenUpdateBody, findToken, tokensFromList, type Token } from './_shared'

/**
 * Deploy Sumo Logic Collector Registration Tokens over the Management API
 * (HTTPS):
 *   read (upsert/rollback): GET  /tokens            → { data: [...] } (not paginated — returns every token)
 *   create:                 POST /tokens            with { type: 'CollectorRegistration', name, description, status }
 *   update:                 PUT  /tokens/<id>        with the same body + the CURRENT live `version` (id lives in the path)
 *
 * The token NAME is the stable identity used to upsert. The generated secret
 * value is never read or written by this config type (see _shared.ts).
 * rollbackData records, per token, the prior body (null when it did not exist)
 * AND the token id — so rollback can restore the prior body (against whatever
 * version is live AT ROLLBACK TIME) or delete the one we created.
 *
 * API: https://help.sumologic.com/docs/api/tokens-library-token-management/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for token deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; tokenId: string | null; token: Token | null }> = []
  const applied: string[] = []

  let live: Token[] = []
  try {
    live = tokensFromList(await getJson<unknown>(`${base}/tokens`, headers))
  } catch {
    live = []
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findToken(live, name)

      if (existing && existing.id != null) {
        const body = buildTokenUpdateBody(item.fields, existing.version ?? 0)
        await sendJson('PUT', `${base}/tokens/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, tokenId: String(existing.id), token: existing })
      } else {
        const created = await sendJson<Token>('POST', `${base}/tokens`, headers, buildTokenCreateBody(item.fields))
        previous.push({ name, tokenId: created?.id != null ? String(created.id) : null, token: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} token(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Token deploy failed after ${applied.length} token(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
