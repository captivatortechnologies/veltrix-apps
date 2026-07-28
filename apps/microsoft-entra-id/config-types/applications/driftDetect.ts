import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  canonicalAppRoles,
  canonicalRequiredResourceAccess,
  canonicalStringList,
  effectiveUniqueName,
  extractApplicationSpecs,
  hasText,
  parseJsonArray,
  type LiveApplication,
} from './validate'

const BASE = '/applications'
const SELECT =
  '?$select=id,displayName,uniqueName,signInAudience,identifierUris,web,spa,appRoles,requiredResourceAccess,groupMembershipClaims,tags'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractApplicationSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveApplication>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByUnique = new Map(
    listed.items.filter((a) => a.uniqueName).map((a) => [a.uniqueName!.toLowerCase(), a]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    // Match only by our immutable uniqueName — never by (non-unique) displayName,
    // so drift never compares against an unrelated same-named registration.
    const live = liveByUnique.get(effectiveUniqueName(spec).toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    // signInAudience — always managed
    if ((live.signInAudience ?? '') !== spec.signInAudience) {
      diffs.push({
        field: `${spec.name}.signInAudience`,
        expected: spec.signInAudience,
        actual: live.signInAudience ?? '',
        severity: 'warning',
      })
    }

    // Compare each remaining field only when the config declares it — mirrors
    // deploy, which only writes declared fields (so we never flag drift on a
    // field we would not correct).
    if (spec.redirectUris.length) {
      const want = canonicalStringList(spec.redirectUris)
      const got = canonicalStringList(live.web?.redirectUris ?? [])
      if (want !== got) {
        diffs.push({ field: `${spec.name}.redirectUris`, expected: want, actual: got, severity: 'warning' })
      }
    }
    if (spec.spaRedirectUris.length) {
      const want = canonicalStringList(spec.spaRedirectUris)
      const got = canonicalStringList(live.spa?.redirectUris ?? [])
      if (want !== got) {
        diffs.push({ field: `${spec.name}.spaRedirectUris`, expected: want, actual: got, severity: 'warning' })
      }
    }
    if (spec.identifierUris.length) {
      const want = canonicalStringList(spec.identifierUris)
      const got = canonicalStringList(live.identifierUris ?? [])
      if (want !== got) {
        diffs.push({ field: `${spec.name}.identifierUris`, expected: want, actual: got, severity: 'warning' })
      }
    }
    if (spec.groupMembershipClaims) {
      if ((live.groupMembershipClaims ?? '') !== spec.groupMembershipClaims) {
        diffs.push({
          field: `${spec.name}.groupMembershipClaims`,
          expected: spec.groupMembershipClaims,
          actual: live.groupMembershipClaims ?? '',
          severity: 'warning',
        })
      }
    }
    if (hasText(spec.appRoles)) {
      const want = canonicalAppRoles(parseJsonArray(spec.appRoles) ?? [])
      const got = canonicalAppRoles(live.appRoles ?? [])
      if (want !== got) {
        diffs.push({ field: `${spec.name}.appRoles`, expected: want, actual: got, severity: 'warning' })
      }
    }
    if (hasText(spec.requiredResourceAccess)) {
      const want = canonicalRequiredResourceAccess(parseJsonArray(spec.requiredResourceAccess) ?? [])
      const got = canonicalRequiredResourceAccess(live.requiredResourceAccess ?? [])
      if (want !== got) {
        diffs.push({
          field: `${spec.name}.requiredResourceAccess`,
          expected: want,
          actual: got,
          severity: 'warning',
        })
      }
    }
    if (spec.tags.length) {
      const want = canonicalStringList(spec.tags)
      const got = canonicalStringList(live.tags ?? [])
      if (want !== got) {
        diffs.push({ field: `${spec.name}.tags`, expected: want, actual: got, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
