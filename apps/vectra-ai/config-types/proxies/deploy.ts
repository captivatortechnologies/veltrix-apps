import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, getJson, sendJson } from '../../lib/vectraApi'
import { buildProxyBody, proxiesFromList, findProxy, idOfProxy, type VectraProxy } from './_shared'

/**
 * Deploy Vectra proxies over the Detect REST API (v2.5, 443):
 *   read (rollback): GET   /proxies            → find the live proxy by address
 *   create:          POST  /proxies            body { proxy: { address, considerProxy } }
 *   update:          PATCH /proxies/{id}        body { proxy: { address, considerProxy } }
 *
 * The proxy address is the stable identity used to upsert. rollbackData records, per
 * proxy, the prior proxy (null when it did not exist) AND the proxy id — so rollback
 * can restore the prior state or delete the one we created. Verify against a live
 * Vectra brain.
 */
async function listProxies(base: string, headers: Record<string, string>): Promise<VectraProxy[]> {
  try {
    return proxiesFromList(await getJson<unknown>(`${base}/proxies`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for proxy deployment' }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ address: string; proxyId: number | string | null; proxy: VectraProxy | null }> = []
  const applied: string[] = []

  try {
    const live = await listProxies(base, headers)

    for (const item of items) {
      const address = String(item.fields.address ?? '').trim()
      if (!address) continue

      const existing = findProxy(live, address)
      const body = buildProxyBody(item.fields)
      const existingId = idOfProxy(existing)

      if (existing && existingId != null) {
        await sendJson('PATCH', `${base}/proxies/${encodeURIComponent(String(existingId))}`, headers, body)
        previous.push({ address, proxyId: existingId, proxy: existing })
      } else {
        const created = await sendJson<VectraProxy>('POST', `${base}/proxies`, headers, body)
        previous.push({ address, proxyId: idOfProxy(created), proxy: null })
      }
      applied.push(address)
    }

    return {
      success: true,
      message: `Applied ${applied.length} proxy(ies): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Proxy deploy failed after ${applied.length} proxy(ies): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
