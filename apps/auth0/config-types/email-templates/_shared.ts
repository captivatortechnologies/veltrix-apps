// Shared helpers for the Auth0 Email Templates config type (deploy + rollback + drift).
//
// Auth0 pre-defines a FIXED set of email template names — there is no "create a
// template with an arbitrary name". Each is read/written at its own path:
//   GET   /api/v2/email-templates/{templateName}   404 if never customized
//   POST  /api/v2/email-templates                  first-time customization (body includes `template`)
//   PATCH /api/v2/email-templates/{templateName}    every later deploy (template omitted — fixed by the URL)
// Auth0 has NO delete for a template: once customized, it always exists. Rollback
// of a template this config type created (see rollback.ts) can only disable it,
// not remove it.
//
// Verified against the official Auth0 Management API v2 (Email Templates):
//   https://auth0.com/docs/api/management/v2/email-templates/post-email-templates
//   https://auth0.com/docs/api/management/v2/email-templates/get-email-templates-by-template-name
//   https://auth0.com/docs/api/management/v2/email-templates/patch-email-templates-by-template-name

import { readOptionalInt, readOptionalString, readString } from '../../lib/fields'

/** Auth0's fixed built-in email template names this config type authors. */
export const EMAIL_TEMPLATE_NAMES = new Set([
  'verify_email',
  'verify_email_by_code',
  'welcome_email',
  'reset_email',
  'reset_email_by_code',
  'blocked_account',
  'stolen_credentials',
  'enrollment_email',
  'mfa_oob_code',
  'user_invitation',
  'async_approval',
  'change_password',
  'password_reset',
])

/** One email template as returned by the Management API. */
export interface Auth0EmailTemplate {
  template?: string
  body?: string | null
  from?: string | null
  subject?: string | null
  syntax?: string | null
  urlLifetimeInSeconds?: number | null
  includeEmailInRedirect?: boolean | null
  resultUrl?: string | null
  enabled?: boolean | null
  [key: string]: unknown
}

/** The create body — `template` is only sent when customizing for the first time. */
export interface EmailTemplateCreateBody {
  template: string
  body: string
  from?: string
  subject: string
  syntax?: string
  urlLifetimeInSeconds?: number
  includeEmailInRedirect?: boolean
  resultUrl?: string
  enabled: boolean
}

/** The update body — `template` is omitted (fixed by the URL path, not patchable). */
export type EmailTemplateUpdateBody = Omit<EmailTemplateCreateBody, 'template'>

function readEnabled(value: unknown): boolean {
  return value === undefined ? true : value === true || value === 'true'
}

/** Build the fields common to create + update from canvas fields. */
function commonBody(fields: Record<string, unknown>): EmailTemplateUpdateBody {
  const body: EmailTemplateUpdateBody = {
    body: readString(fields.body),
    subject: readString(fields.subject),
    enabled: readEnabled(fields.enabled),
  }
  const from = readOptionalString(fields.from)
  if (from !== undefined) body.from = from
  const syntax = readOptionalString(fields.syntax)
  if (syntax !== undefined) body.syntax = syntax
  const resultUrl = readOptionalString(fields.result_url)
  if (resultUrl !== undefined) body.resultUrl = resultUrl
  const urlLifetime = readOptionalInt(fields.url_lifetime_in_seconds)
  if (urlLifetime !== undefined) body.urlLifetimeInSeconds = urlLifetime
  if (fields.include_email_in_redirect !== undefined) {
    body.includeEmailInRedirect = fields.include_email_in_redirect === true || fields.include_email_in_redirect === 'true'
  }
  return body
}

/** Build the create (first-customization) body — includes `template`. */
export function buildEmailTemplateCreateBody(fields: Record<string, unknown>): EmailTemplateCreateBody {
  return { template: readString(fields.template), ...commonBody(fields) }
}

/** Build the update body — `template` omitted (immutable / URL-fixed). */
export function buildEmailTemplateUpdateBody(fields: Record<string, unknown>): EmailTemplateUpdateBody {
  return commonBody(fields)
}

/** Capture the prior managed state of a live template for rollback. */
export function snapshotEmailTemplate(tpl: Auth0EmailTemplate): EmailTemplateUpdateBody {
  const body: EmailTemplateUpdateBody = {
    body: typeof tpl.body === 'string' ? tpl.body : '',
    subject: typeof tpl.subject === 'string' ? tpl.subject : '',
    enabled: tpl.enabled !== false,
  }
  if (typeof tpl.from === 'string' && tpl.from) body.from = tpl.from
  if (typeof tpl.syntax === 'string' && tpl.syntax) body.syntax = tpl.syntax
  if (typeof tpl.resultUrl === 'string' && tpl.resultUrl) body.resultUrl = tpl.resultUrl
  if (typeof tpl.urlLifetimeInSeconds === 'number') body.urlLifetimeInSeconds = tpl.urlLifetimeInSeconds
  if (typeof tpl.includeEmailInRedirect === 'boolean') body.includeEmailInRedirect = tpl.includeEmailInRedirect
  return body
}
