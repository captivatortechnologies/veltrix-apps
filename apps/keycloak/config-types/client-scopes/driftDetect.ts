import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAdminClient, parseJson, resolveGrant } from '../../lib/keycloakApi'
import { readString } from '../../lib/fields'
import {
  findClientScopeByName,
  projectFromFields,
  projectFromLive,
  resolveRealmDefaultState,
  type KeycloakClientScopeRep,
  type RealmDefaultState,
} from './_shared'

/**
 * Drift for client scopes: compare the fields we declare (protocol, consent-screen
 * visibility/text, token-scope and discovery-metadata inclusion, GUI order, realm
 * assignment) against the live scope in Keycloak. Best-effort — a scope that
 * can't be matched or read (missing / transient error) is skipped rather than
 * raising false drift. Read-only: GET /client-scopes,
 * GET /default-default-client-scopes, GET /default-optional-client-scopes.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveGrant(credential)) return { hasDrift: false, diffs }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })

  for (const item of items) {
    const name = readString(item.fields.name)
    if (!name) continue

    let match: KeycloakClientScopeRep | null
    try {
      const res = await admin.get('/client-scopes')
      if (!res.ok) continue // best-effort: can't read, don't assert drift
      const list = parseJson<KeycloakClientScopeRep[]>(res.body) ?? []
      match = findClientScopeByName(list, name)
    } catch {
      continue
    }
    if (!match || !match.id) continue

    const expected = projectFromFields(item.fields)
    const actual = projectFromLive(match)

    if (expected.protocol !== actual.protocol) {
      diffs.push({ field: `${name}.protocol`, expected: expected.protocol, actual: actual.protocol, severity: 'warning' })
    }
    if (expected.displayOnConsentScreen !== actual.displayOnConsentScreen) {
      diffs.push({
        field: `${name}.displayOnConsentScreen`,
        expected: expected.displayOnConsentScreen,
        actual: actual.displayOnConsentScreen,
        severity: 'warning',
      })
    }
    // Only assert consentScreenText/guiOrder drift when we actually declare them.
    if (expected.consentScreenText !== undefined && expected.consentScreenText !== actual.consentScreenText) {
      diffs.push({
        field: `${name}.consentScreenText`,
        expected: expected.consentScreenText,
        actual: actual.consentScreenText,
        severity: 'warning',
      })
    }
    if (expected.includeInTokenScope !== actual.includeInTokenScope) {
      diffs.push({
        field: `${name}.includeInTokenScope`,
        expected: expected.includeInTokenScope,
        actual: actual.includeInTokenScope,
        severity: 'warning',
      })
    }
    if (expected.includeInOpenidProviderMetadata !== actual.includeInOpenidProviderMetadata) {
      diffs.push({
        field: `${name}.includeInOpenidProviderMetadata`,
        expected: expected.includeInOpenidProviderMetadata,
        actual: actual.includeInOpenidProviderMetadata,
        severity: 'warning',
      })
    }
    if (expected.guiOrder !== undefined && expected.guiOrder !== actual.guiOrder) {
      diffs.push({ field: `${name}.guiOrder`, expected: expected.guiOrder, actual: actual.guiOrder, severity: 'warning' })
    }

    try {
      const desiredRealmDefault = (readString(item.fields.realmDefault) || 'none') as RealmDefaultState
      const actualRealmDefault = await resolveRealmDefaultState(admin, match.id)
      if (desiredRealmDefault !== actualRealmDefault) {
        diffs.push({
          field: `${name}.realmDefault`,
          expected: desiredRealmDefault,
          actual: actualRealmDefault,
          severity: 'warning',
        })
      }
    } catch {
      // best-effort: couldn't read the realm-assignment lists — don't assert drift on it
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
