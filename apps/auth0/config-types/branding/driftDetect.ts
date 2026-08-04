import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { resolveDomain, buildApiBase, fetchManagementToken, resolveClientCredentials, getJson, getTextOrNull } from '../../lib/auth0Api'
import { readOptionalString } from '../../lib/fields'
import { buildBrandingBody, buildPromptsBody, type Auth0Branding, type Auth0Prompts } from './_shared'

/**
 * Drift for the Auth0 branding singleton: compare every DECLARED branding field,
 * the (always-declared) login-experience fields, and the custom Universal Login
 * HTML against live Auth0 state. Only fields the operator set are compared for
 * `/branding`, so undeclared branding is never flagged as drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  const diffs: DriftDiff[] = []
  if (!item) return { hasDrift: false, diffs }

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

  try {
    const declaredBranding = buildBrandingBody(item.fields)
    if (Object.keys(declaredBranding).length > 0) {
      const liveBranding = await getJson<Auth0Branding>(`${base}/branding`, accessToken)
      if (declaredBranding.logo_url !== undefined && declaredBranding.logo_url !== (liveBranding.logo_url ?? '')) {
        diffs.push({ field: 'logo_url', expected: declaredBranding.logo_url, actual: liveBranding.logo_url ?? '', severity: 'warning' })
      }
      if (declaredBranding.favicon_url !== undefined && declaredBranding.favicon_url !== (liveBranding.favicon_url ?? '')) {
        diffs.push({ field: 'favicon_url', expected: declaredBranding.favicon_url, actual: liveBranding.favicon_url ?? '', severity: 'warning' })
      }
      if (declaredBranding.colors?.primary !== undefined && declaredBranding.colors.primary !== (liveBranding.colors?.primary ?? '')) {
        diffs.push({ field: 'colors.primary', expected: declaredBranding.colors.primary, actual: liveBranding.colors?.primary ?? '', severity: 'warning' })
      }
      if (
        declaredBranding.colors?.page_background !== undefined &&
        declaredBranding.colors.page_background !== (liveBranding.colors?.page_background ?? '')
      ) {
        diffs.push({
          field: 'colors.page_background',
          expected: declaredBranding.colors.page_background,
          actual: liveBranding.colors?.page_background ?? '',
          severity: 'warning',
        })
      }
      if (declaredBranding.font?.url !== undefined && declaredBranding.font.url !== (liveBranding.font?.url ?? '')) {
        diffs.push({ field: 'font.url', expected: declaredBranding.font.url, actual: liveBranding.font?.url ?? '', severity: 'warning' })
      }
    }
  } catch {
    // best-effort — a transient branding read failure is not asserted as drift
  }

  try {
    const declaredPrompts = buildPromptsBody(item.fields)
    const livePrompts = await getJson<Auth0Prompts>(`${base}/prompts`, accessToken)
    if (declaredPrompts.universal_login_experience !== (livePrompts.universal_login_experience ?? 'new')) {
      diffs.push({
        field: 'universal_login_experience',
        expected: declaredPrompts.universal_login_experience,
        actual: livePrompts.universal_login_experience ?? 'new',
        severity: 'warning',
      })
    }
    if (declaredPrompts.identifier_first !== (livePrompts.identifier_first === true)) {
      diffs.push({
        field: 'identifier_first',
        expected: String(declaredPrompts.identifier_first),
        actual: String(livePrompts.identifier_first === true),
        severity: 'warning',
      })
    }
    if (declaredPrompts.webauthn_platform_first_factor !== (livePrompts.webauthn_platform_first_factor === true)) {
      diffs.push({
        field: 'webauthn_platform_first_factor',
        expected: String(declaredPrompts.webauthn_platform_first_factor),
        actual: String(livePrompts.webauthn_platform_first_factor === true),
        severity: 'warning',
      })
    }
  } catch {
    // best-effort
  }

  const declaredHtml = readOptionalString(item.fields.universal_login_body)
  if (declaredHtml !== undefined) {
    try {
      const liveHtml = (await getTextOrNull(`${base}/branding/templates/universal-login`, accessToken)) ?? ''
      if (declaredHtml !== liveHtml) {
        diffs.push({ field: 'universal_login_body', expected: '(declared HTML)', actual: '(live HTML differs)', severity: 'warning' })
      }
    } catch {
      // best-effort
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
