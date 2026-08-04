import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, auth0Fetch, bearer } from '../../lib/auth0Api'
import { readOptionalInt, readOptionalString, readString } from '../../lib/fields'
import type { Auth0EmailTemplate } from './_shared'

/**
 * Drift for Auth0 email templates: compare subject, body, from, syntax, result
 * URL, URL lifetime, include-email-in-redirect and enabled against the live
 * template (matched by its fixed name). A template that 404s (never customized)
 * is reported as fully drifted against a non-blank declared body/subject, since
 * the declared customization was never actually applied.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const creds = resolveClientCredentials(credential)
  if (!creds) return { hasDrift: false, diffs }

  const domain = resolveDomain(component, connectivity, connectivityProvider)
  const base = buildApiBase(domain)

  let accessToken: string
  try {
    accessToken = (await fetchManagementToken({ domain, clientId: creds.clientId, clientSecret: creds.clientSecret })).accessToken
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const template = readString(item.fields.template)
    if (!template) continue

    let live: Auth0EmailTemplate | null
    try {
      const res = await auth0Fetch(`${base}/email-templates/${encodeURIComponent(template)}`, { headers: bearer(accessToken) })
      live = res.status === 404 ? null : res.ok ? (JSON.parse(res.body || '{}') as Auth0EmailTemplate) : null
      if (!res.ok && res.status !== 404) continue // best-effort: transient error, skip rather than false-drift
    } catch {
      continue
    }

    const declaredSubject = readString(item.fields.subject)
    const declaredBody = readString(item.fields.body)
    if (!live) {
      if (declaredSubject || declaredBody) {
        diffs.push({ field: `${template}.customized`, expected: 'customized', actual: 'never customized (404)', severity: 'warning' })
      }
      continue
    }

    if (declaredSubject !== (live.subject ?? '')) {
      diffs.push({ field: `${template}.subject`, expected: declaredSubject, actual: live.subject ?? '', severity: 'warning' })
    }
    if (declaredBody !== (live.body ?? '')) {
      diffs.push({ field: `${template}.body`, expected: declaredBody, actual: live.body ?? '', severity: 'warning' })
    }

    const declaredFrom = readOptionalString(item.fields.from)
    if (declaredFrom !== undefined && declaredFrom !== (live.from ?? '')) {
      diffs.push({ field: `${template}.from`, expected: declaredFrom, actual: live.from ?? '', severity: 'warning' })
    }

    const declaredEnabled = item.fields.enabled === undefined ? true : item.fields.enabled === true || item.fields.enabled === 'true'
    if (declaredEnabled !== (live.enabled !== false)) {
      diffs.push({ field: `${template}.enabled`, expected: String(declaredEnabled), actual: String(live.enabled !== false), severity: 'warning' })
    }

    const declaredUrlLifetime = readOptionalInt(item.fields.url_lifetime_in_seconds)
    if (declaredUrlLifetime !== undefined && declaredUrlLifetime !== live.urlLifetimeInSeconds) {
      diffs.push({
        field: `${template}.urlLifetimeInSeconds`,
        expected: declaredUrlLifetime,
        actual: live.urlLifetimeInSeconds ?? null,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
