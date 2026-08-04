import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  sendJson,
  putText,
  deleteResource,
  getTextOrNull,
} from '../../lib/auth0Api'
import type { Auth0Branding, Auth0Prompts } from './_shared'

/**
 * Undo a branding deploy from rollbackData (written by deploy()): PATCH
 * /branding and /prompts back to their prior snapshots, and restore the prior
 * Universal Login HTML — PUT it back if it existed before, or DELETE the
 * template (revert to Auth0's default) if it did not.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    priorBranding?: Auth0Branding
    priorPrompts?: Auth0Prompts
    priorUniversalLoginHtml?: string | null
  }
  if (!data.priorBranding && !data.priorPrompts && data.priorUniversalLoginHtml === undefined) {
    return { success: true, message: 'Nothing to roll back.' }
  }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    if (data.priorBranding) await sendJson('PATCH', `${base}/branding`, accessToken, data.priorBranding)
    if (data.priorPrompts) await sendJson('PATCH', `${base}/prompts`, accessToken, data.priorPrompts)

    if (data.priorUniversalLoginHtml !== undefined) {
      const path = `${base}/branding/templates/universal-login`
      if (data.priorUniversalLoginHtml !== null) {
        await putText(path, accessToken, data.priorUniversalLoginHtml)
      } else if ((await getTextOrNull(path, accessToken)) !== null) {
        await deleteResource(path, accessToken)
      }
    }

    return { success: true, message: 'Rolled back branding, login experience and custom login page.' }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
