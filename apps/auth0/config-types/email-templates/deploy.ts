import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  resolveDomain,
  buildApiBase,
  fetchManagementToken,
  resolveClientCredentials,
  auth0Fetch,
  bearer,
  sendJson,
} from '../../lib/auth0Api'
import { readString } from '../../lib/fields'
import {
  buildEmailTemplateCreateBody,
  buildEmailTemplateUpdateBody,
  snapshotEmailTemplate,
  type Auth0EmailTemplate,
  type EmailTemplateUpdateBody,
} from './_shared'

/**
 * Deploy Auth0 Email Templates over the Management API v2:
 *   read (identity + rollback): GET  /api/v2/email-templates/{template}  → 404 = never customized
 *   first customization:        POST /api/v2/email-templates              with template + full body
 *   every later deploy:         PATCH /api/v2/email-templates/{template}  with the body (template omitted)
 *
 * Templates are keyed by their FIXED name (there is no arbitrary create), so this
 * config type upserts by that name directly — no list-and-match step. rollbackData
 * records, per template, the prior body (null when it had never been customized)
 * so rollback can restore it or (Auth0 has no delete for a template) disable one
 * this deploy customized for the first time.
 */
async function fetchTemplateOrNull(base: string, template: string, token: string): Promise<Auth0EmailTemplate | null> {
  const res = await auth0Fetch(`${base}/email-templates/${encodeURIComponent(template)}`, { headers: bearer(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET email-templates/${template} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return JSON.parse(res.body || '{}') as Auth0EmailTemplate
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  const creds = resolveClientCredentials(credential)
  if (!creds) {
    return { success: false, message: 'Missing Client ID / Client Secret credential for Auth0 deployment' }
  }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  const previous: Array<{ template: string; prior: EmailTemplateUpdateBody | null }> = []
  const applied: string[] = []

  try {
    const { accessToken } = await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })

    for (const item of items) {
      const template = readString(item.fields.template)
      if (!template) continue

      const existing = await fetchTemplateOrNull(base, template, accessToken)
      if (existing) {
        await sendJson('PATCH', `${base}/email-templates/${encodeURIComponent(template)}`, accessToken, buildEmailTemplateUpdateBody(item.fields))
        previous.push({ template, prior: snapshotEmailTemplate(existing) })
      } else {
        await sendJson('POST', `${base}/email-templates`, accessToken, buildEmailTemplateCreateBody(item.fields))
        previous.push({ template, prior: null })
      }
      applied.push(template)
    }

    return {
      success: true,
      message: `Applied ${applied.length} email template(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Auth0 email template deploy failed after ${applied.length} template(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
