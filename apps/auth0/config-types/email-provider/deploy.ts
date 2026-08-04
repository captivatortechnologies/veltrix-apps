import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { auth0Fetch, bearer, resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import { buildEmailProviderBody, EMAIL_PROVIDER_PATH, snapshotEmailProvider, type Auth0EmailProvider, type EmailProviderSnapshot } from './_shared'

/**
 * Deploy the Auth0 Email Provider over the Management API v2. Unlike the
 * other singletons in this app, /emails/provider does not always exist: GET
 * 404s when unconfigured — that is "no prior provider", not an error. PATCH
 * an existing provider, or POST to configure one for the first time.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No email provider configured.', rollbackData: { existed: false, prior: null } }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)
  const url = `${base}/${EMAIL_PROVIDER_PATH}`

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const getRes = await auth0Fetch(url, { headers: bearer(accessToken) })
    let existed: boolean
    let priorSnapshot: EmailProviderSnapshot | null = null
    if (getRes.status === 404) {
      existed = false
    } else if (getRes.ok) {
      existed = true
      const live = JSON.parse(getRes.body || '{}') as Auth0EmailProvider
      priorSnapshot = snapshotEmailProvider(live)
    } else {
      return { success: false, message: `Failed to read the current email provider (HTTP ${getRes.status}): ${getRes.body.slice(0, 300)}` }
    }

    const body = buildEmailProviderBody(item.fields)
    if (existed) {
      await sendJson('PATCH', url, accessToken, body)
    } else {
      await sendJson('POST', url, accessToken, body)
    }

    return {
      success: true,
      message: existed ? 'Updated the Auth0 email provider.' : 'Configured the Auth0 email provider.',
      rollbackData: { existed, prior: priorSnapshot },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 email provider deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
