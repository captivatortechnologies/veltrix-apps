import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
  sendJson,
} from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildCustomDomainCreateBody,
  buildCustomDomainUpdateBody,
  findCustomDomainByDomain,
  snapshotCustomDomain,
  type Auth0CustomDomain,
  type CustomDomainUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Custom Domains over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/custom-domains      → match by domain
 *   create:                     POST /api/v2/custom-domains        with domain + type (+ tls_policy/ip header/metadata)
 *   update:                     PATCH /api/v2/custom-domains/{id}  without domain/type (immutable)
 *
 * Upserts by DOMAIN: list live custom domains, PATCH one with the same domain
 * else POST a new one. rollbackData records, per domain, the prior managed body
 * (null when it did not exist) AND the id — so rollback restores the prior
 * body or deletes the one we created.
 *
 * LIMITATION: a newly created domain comes back pending_verification and
 * requires a manual DNS/CNAME (or TXT) proof plus POST
 * /custom-domains/{id}/verify. This handler intentionally stops at
 * create/update — it cannot prove DNS ownership on the operator's behalf, so
 * verification is a manual follow-up outside this pipeline.
 *
 * Unlike every other list endpoint in this app, GET /custom-domains is NOT
 * paginated (Auth0 caps a tenant at a small number of custom domains), so this
 * reads the plain array with `getJson` — no `listAllPages`, no per_page/page.
 */
interface CustomDomainSummary {
  id?: string
  domain?: string
}

async function listCustomDomains(base: string, token: string): Promise<Auth0CustomDomain[]> {
  const list = await getJson<Auth0CustomDomain[]>(`${base}/custom-domains`, token)
  return Array.isArray(list) ? list : []
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domainHost = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domainHost)

  const previous: Array<{ domain: string; customDomainId: string | null; prior: CustomDomainUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain: domainHost, clientId: creds.clientId, clientSecret: creds.clientSecret })
    const live = await listCustomDomains(base, accessToken)

    for (const item of items) {
      const domain = readString(item.fields.domain)
      if (!domain) continue

      const existing = findCustomDomainByDomain(live, domain)
      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/custom-domains/${encodeURIComponent(existing.id)}`, accessToken, buildCustomDomainUpdateBody(item.fields))
        previous.push({ domain, customDomainId: existing.id, prior: snapshotCustomDomain(existing) })
      } else {
        const created = await sendJson<CustomDomainSummary>('POST', `${base}/custom-domains`, accessToken, buildCustomDomainCreateBody(item.fields))
        previous.push({ domain, customDomainId: created?.id ?? null, prior: null })
      }
      applied.push(domain)
    }

    return {
      success: true,
      message: `Applied ${applied.length} custom domain(s): ${applied.join(', ') || '(none)'}. Newly created domains are pending_verification — complete DNS verification in the Auth0 dashboard.`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 custom domain deploy failed after ${applied.length} domain(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
