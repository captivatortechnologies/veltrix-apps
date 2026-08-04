import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, sendJson } from '../../lib/auth0Api'
import type { EmailTemplateUpdateBody } from './_shared'

/**
 * Undo an email-templates deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, PATCH /api/v2/email-templates/{template} to
 * restore it. Auth0 has NO delete endpoint for an email template — once
 * customized (POST), it always exists — so a template this deploy customized for
 * the FIRST time (prior null) can only be soft-reverted: PATCH it back to
 * `enabled: false` rather than removed.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ template: string; prior: EmailTemplateUpdateBody | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 rollback' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let restored = 0
  let disabled = 0
  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    for (const { template, prior } of previous) {
      const path = `${base}/email-templates/${encodeURIComponent(template)}`
      if (prior) {
        await sendJson('PATCH', path, accessToken, prior)
        restored++
      } else {
        await sendJson('PATCH', path, accessToken, { enabled: false })
        disabled++
      }
    }
    return {
      success: true,
      message: `Rolled back email templates: ${restored} restored${disabled ? `, ${disabled} disabled (Auth0 has no delete for a template)` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
