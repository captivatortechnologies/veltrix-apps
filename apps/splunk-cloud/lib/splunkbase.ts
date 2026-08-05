// =============================================================================
// Splunkbase session client.
//
// Installing a PUBLISHED Splunkbase app through ACS (unlike a private app,
// which this app BUILDS from authored files) needs a Splunkbase session id in
// addition to the ACS stack token:
//
//   ACS         the Splunk Cloud stack token (sc_admin)     -> Authorization: Bearer
//   Splunkbase  a splunk.com account (username + password)  -> a session id,
//               sent as X-Splunkbase-Authorization
//
// The session id is obtained from Splunkbase's own login endpoint (NOT ACS,
// NOT api.splunk.com/AppInspect — those are separate services). A splunk.com
// account is also a Splunkbase account, so this is the SAME username/password
// this app already asks for on the "Splunk Apps" (private app / AppInspect)
// configuration type — see lib/appInspect.ts.
//
// Endpoint (documented by Splunk):
//   login  POST https://splunkbase.splunk.com/api/account:login   (form: username, password)
//          -> XML body containing <id>...</id>, the session id
//
// Docs: help.splunk.com …/manage-splunkbase-apps-in-splunk-cloud-platform
// =============================================================================

import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const SPLUNKBASE_LOGIN_URL = 'https://splunkbase.splunk.com/api/account:login'

export interface SplunkbaseCredentials {
  username: string
  password: string
}

/**
 * Splunkbase authenticates with a splunk.com account, not the stack token —
 * the SAME username/password field this app already uses for AppInspect.
 * Returns null when either half is missing.
 */
export function resolveSplunkbaseCredentials(
  credential: CredentialRef | null,
): SplunkbaseCredentials | null {
  const username = credential?.username?.trim() ?? ''
  const password = credential?.password ?? ''
  if (!username || !password) return null
  return { username, password }
}

export const MISSING_SPLUNKBASE_CREDENTIALS_MESSAGE =
  'Splunkbase app install requires a splunk.com account IN ADDITION to the ACS stack token — the SAME ' +
  'username/password already used for private-app AppInspect vetting (the ACS JWT stays in the "API token" field).'

export interface SplunkbaseLoginOptions {
  timeoutMs?: number
  /** Overridable for tests; defaults to the public service. */
  loginUrl?: string
}

/** Pull the session id out of Splunkbase's XML login response (`<id>...</id>`). */
export function extractSessionId(body: string): string | null {
  const match = /<id>([^<]+)<\/id>/i.exec(body)
  const id = match?.[1]?.trim()
  return id && id.length > 0 ? id : null
}

/**
 * Exchange a splunk.com username/password for a Splunkbase session id.
 * Sent as multipart/form-data (matching Splunk's own documented curl example,
 * `--form username=... --form password=...`).
 */
export async function splunkbaseLogin(
  credentials: SplunkbaseCredentials,
  options: SplunkbaseLoginOptions = {},
): Promise<string> {
  const form = new FormData()
  form.set('username', credentials.username)
  form.set('password', credentials.password)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)

  let res: Response
  try {
    res = await fetch(options.loginUrl ?? SPLUNKBASE_LOGIN_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
  } catch (error) {
    throw new Error(
      `Could not reach Splunkbase to authenticate: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Splunkbase login failed (HTTP ${res.status}) — the splunk.com username/password on the credential were rejected.`,
    )
  }
  if (!res.ok) {
    throw new Error(`Splunkbase login failed (HTTP ${res.status})`)
  }

  const sessionId = extractSessionId(text)
  if (!sessionId) {
    throw new Error('Splunkbase login returned no session id (expected an <id> element in the response)')
  }
  return sessionId
}
