import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractOAuth2GrantSpecs, grantKey, normalizeScope, type LiveOAuth2Grant } from './validate'
import { buildServicePrincipalNameToId, buildUserNameToId, resolveRef } from '../lib/nameMaps'

const BASE = '/oauth2PermissionGrants'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractOAuth2GrantSpecs(ctx.deployedConfig).filter((s) => s.clientId && s.resourceId)
  const listed = await client.getAll<LiveOAuth2Grant>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(listed.items.filter((g) => g.id).map((g) => [grantKey(g), g]))

  // Same id-aware resolution as deploy.ts — a hand-typed display name must
  // resolve to the same id Graph's live grants are keyed on, or every such
  // grant would spuriously show as "absent".
  const [spNameToId, userNameToId] = await Promise.all([
    buildServicePrincipalNameToId(client),
    buildUserNameToId(client),
  ])

  const diffs: Diffs = []
  for (const spec of specs) {
    const clientRef = resolveRef(spec.clientId, spNameToId)
    const resourceRef = resolveRef(spec.resourceId, spNameToId)
    const principalRef = spec.consentType === 'Principal' ? resolveRef(spec.principalId, userNameToId) : { id: '', missing: false }
    if (clientRef.missing || resourceRef.missing || principalRef.missing) {
      diffs.push({
        field: `${spec.clientId} -> ${spec.resourceId}`,
        expected: 'resolvable',
        actual: 'unknown client/resource/principal reference',
        severity: 'critical',
      })
      continue
    }

    const key = grantKey({
      clientId: clientRef.id,
      resourceId: resourceRef.id,
      consentType: spec.consentType,
      principalId: principalRef.id,
    })
    const live = liveByKey.get(key)
    if (!live) {
      diffs.push({ field: key, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const want = normalizeScope(spec.scope)
    const actual = normalizeScope(live.scope)
    if (want !== actual) {
      diffs.push({ field: `${key}.scope`, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
