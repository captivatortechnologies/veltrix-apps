// Shared helpers for the Auth0 Email Provider config type (deploy + rollback +
// drift). Unlike the other three singletons in this app, /emails/provider does
// NOT always exist — GET 404s until a provider has ever been configured, so
// this config type POSTs to configure it for the first time and PATCHes an
// existing one; rollback DELETEs a provider it created.
//
// Auth0 never returns credential values on GET — they are write-only — so
// secret-bearing credential keys are excluded from drift comparison entirely
// and cannot be restored on rollback; only name/enabled/default_from_address/
// settings are restorable.
//
// Verified against the official Auth0 Management API v2 (Emails):
//   https://auth0.com/docs/api/management/v2/emails

import { parseJsonObject, readString, stripSecretKeys } from '../../lib/fields'

export const EMAIL_PROVIDER_PATH = 'emails/provider'

/** Supported Auth0 email provider names this config type authors. */
export const EMAIL_PROVIDER_NAMES = new Set([
  'mailgun',
  'mandrill',
  'sendgrid',
  'resend',
  'ses',
  'sparkpost',
  'smtp',
  'azure_cs',
  'ms365',
  'custom',
])

/** One email provider as returned by the Management API (credentials are write-only, never returned in full). */
export interface Auth0EmailProvider {
  name?: string
  enabled?: boolean
  default_from_address?: string
  credentials?: Record<string, unknown>
  settings?: Record<string, unknown>
  [key: string]: unknown
}

/** The create/update body — credentials are supplied on every write (write-only on Auth0's side). */
export interface EmailProviderBody {
  name: string
  enabled: boolean
  default_from_address: string
  credentials: Record<string, unknown>
  settings?: Record<string, unknown>
}

/** Build the create/update body from canvas fields. */
export function buildEmailProviderBody(fields: Record<string, unknown>): EmailProviderBody {
  const credentials = parseJsonObject(fields.credentials)
  const settings = parseJsonObject(fields.settings)
  const body: EmailProviderBody = {
    name: readString(fields.name),
    enabled: fields.enabled === true || fields.enabled === 'true',
    default_from_address: readString(fields.default_from_address),
    credentials: credentials.ok ? credentials.value : {},
  }
  if (settings.ok && Object.keys(settings.value).length > 0) body.settings = settings.value
  return body
}

/** The non-secret prior state of a live provider, captured for rollback + drift. */
export interface EmailProviderSnapshot {
  name: string
  enabled: boolean
  default_from_address: string
  settings: Record<string, unknown>
  nonSecretCredentials: Record<string, unknown>
}

/**
 * Capture the non-secret prior state of a live provider. Never includes raw
 * secret credential values — only the non-secret credential KEYS Auth0 does
 * return (e.g. a Mailgun `domain`), stripped with the same secret-key
 * detection used across this app.
 */
export function snapshotEmailProvider(provider: Auth0EmailProvider): EmailProviderSnapshot {
  return {
    name: typeof provider.name === 'string' ? provider.name : '',
    enabled: provider.enabled === true,
    default_from_address: typeof provider.default_from_address === 'string' ? provider.default_from_address : '',
    settings: (provider.settings as Record<string, unknown>) ?? {},
    nonSecretCredentials: stripSecretKeys((provider.credentials as Record<string, unknown>) ?? {}),
  }
}
