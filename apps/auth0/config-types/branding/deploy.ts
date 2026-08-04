import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  getJson,
  sendJson,
  getTextOrNull,
  putText,
  deleteResource,
} from '../../lib/auth0Api'
import { readOptionalString } from '../../lib/fields'
import { buildBrandingBody, buildPromptsBody, snapshotBranding, snapshotPrompts, type Auth0Branding, type Auth0Prompts } from './_shared'

/**
 * Deploy the Auth0 Branding & Login Experience singleton over the Management API v2:
 *   GET/PATCH      /api/v2/branding                          (optional-omit fields)
 *   GET/PATCH      /api/v2/prompts                            (always fully declared)
 *   GET/PUT/DELETE /api/v2/branding/templates/universal-login  (raw HTML — PUT when
 *                                                               declared, DELETE to
 *                                                               revert to default
 *                                                               when cleared)
 *
 * rollbackData captures the prior state of all three so rollback can restore them.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return { success: true, message: 'No branding configured', rollbackData: {} }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    const priorBranding = await getJson<Auth0Branding>(`${base}/branding`, accessToken)
    await sendJson('PATCH', `${base}/branding`, accessToken, buildBrandingBody(item.fields))

    const priorPrompts = await getJson<Auth0Prompts>(`${base}/prompts`, accessToken)
    await sendJson('PATCH', `${base}/prompts`, accessToken, buildPromptsBody(item.fields))

    const priorUniversalLoginHtml = await getTextOrNull(`${base}/branding/templates/universal-login`, accessToken)
    const declaredHtml = readOptionalString(item.fields.universal_login_body)
    if (declaredHtml !== undefined) {
      await putText(`${base}/branding/templates/universal-login`, accessToken, declaredHtml)
    } else if (priorUniversalLoginHtml !== null) {
      await deleteResource(`${base}/branding/templates/universal-login`, accessToken)
    }

    return {
      success: true,
      message: 'Applied Auth0 branding, login experience and custom login page.',
      rollbackData: {
        priorBranding: snapshotBranding(priorBranding),
        priorPrompts: snapshotPrompts(priorPrompts),
        priorUniversalLoginHtml,
      },
    }
  } catch (error) {
    return { success: false, message: `Auth0 branding deploy failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
