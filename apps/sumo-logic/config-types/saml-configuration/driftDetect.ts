import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { findSamlConfiguration, normalizeBool, type SamlConfiguration } from './_shared'

/**
 * Drift for SAML configurations: compare issuer, certificate, SP-initiated
 * login settings and roles attribute we declare against the live configuration
 * in Sumo Logic (matched by name). Best-effort — a configuration that can't be
 * matched is skipped. Read-only: GET /saml/identityProviders (a bare array,
 * unlike every other list endpoint in this app).
 *
 * API: https://www.sumologic.com/help/docs/api/saml-configuration-management/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let live: SamlConfiguration[]
  try {
    live = await getJson<SamlConfiguration[]>(`${base}/saml/identityProviders`, headers)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read SAML configurations, no drift asserted
  }

  for (const item of items) {
    const configurationName = String(item.fields.configurationName ?? '').trim()
    const match = findSamlConfiguration(live, configurationName)
    if (!match) continue

    const expectedIssuer = String(item.fields.issuer ?? '').trim()
    const actualIssuer = String(match.issuer ?? '').trim()
    if (expectedIssuer && actualIssuer !== expectedIssuer) {
      diffs.push({ field: `${configurationName}.issuer`, expected: expectedIssuer, actual: actualIssuer, severity: 'warning' })
    }

    const expectedCert = String(item.fields.x509cert1 ?? '').trim()
    const actualCert = String(match.x509cert1 ?? '').trim()
    if (expectedCert && actualCert !== expectedCert) {
      diffs.push({ field: `${configurationName}.x509cert1`, expected: '(differs)', actual: '(differs)', severity: 'critical' })
    }

    const expectedSpInitiated = normalizeBool(item.fields.spInitiatedLoginEnabled)
    if (Boolean(match.spInitiatedLoginEnabled) !== expectedSpInitiated) {
      diffs.push({
        field: `${configurationName}.spInitiatedLoginEnabled`,
        expected: expectedSpInitiated,
        actual: Boolean(match.spInitiatedLoginEnabled),
        severity: 'warning',
      })
    }

    const expectedRolesAttribute = String(item.fields.rolesAttribute ?? '').trim()
    const actualRolesAttribute = String(match.rolesAttribute ?? '').trim()
    if (expectedRolesAttribute && actualRolesAttribute !== expectedRolesAttribute) {
      diffs.push({ field: `${configurationName}.rolesAttribute`, expected: expectedRolesAttribute, actual: actualRolesAttribute, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
