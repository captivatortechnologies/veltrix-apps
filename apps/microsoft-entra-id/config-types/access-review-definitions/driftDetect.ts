import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAccessReviewSpecs, parseObject, type LiveAccessReview } from './validate'
import {
  buildAccessPackageNameToId,
  buildGroupNameToId,
  buildRoleNameToId,
  buildServicePrincipalNameToId,
  buildUserNameToId,
} from '../lib/nameMaps'
import { resolveReviewers, resolveScope, type ReviewerNameMaps } from './deploy'

const BASE = '/identityGovernance/accessReviews/definitions'
const SELECT = '?$select=id,displayName,descriptionForAdmins,scope,instanceEnumerationScope,reviewers,fallbackReviewers,settings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAccessReviewSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAccessReview>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((d) => d.displayName).map((d) => [d.displayName!.toLowerCase(), d]))

  const [group, role, accessPackage, servicePrincipal, user] = await Promise.all([
    buildGroupNameToId(client),
    buildRoleNameToId(client),
    buildAccessPackageNameToId(client),
    buildServicePrincipalNameToId(client),
    buildUserNameToId(client),
  ])
  const scopeMaps = { group, role, accessPackage, servicePrincipal }
  const reviewerMaps: ReviewerNameMaps = { user, group }

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((spec.descriptionForAdmins || '') !== (live.descriptionForAdmins ?? '')) {
      diffs.push({
        field: `${spec.name}.descriptionForAdmins`,
        expected: spec.descriptionForAdmins || '',
        actual: live.descriptionForAdmins ?? '',
        severity: 'warning',
      })
    }

    const { resolved, missing } = resolveScope(spec, scopeMaps)
    if (!resolved) {
      diffs.push({
        field: `${spec.name}.scope`,
        expected: 'resolvable',
        actual: missing.length ? `unknown target(s): ${missing.join(', ')}` : 'Custom Scope (JSON) missing or invalid',
        severity: 'critical',
      })
    } else {
      const wantScope = canonical(resolved.scope)
      const actualScope = canonical(live.scope ?? {})
      if (wantScope !== actualScope) {
        diffs.push({ field: `${spec.name}.scope`, expected: wantScope, actual: actualScope, severity: 'warning' })
      }
      const wantInstanceScope = canonical(resolved.instanceEnumerationScope ?? null)
      const actualInstanceScope = canonical(live.instanceEnumerationScope ?? null)
      if (wantInstanceScope !== actualInstanceScope) {
        diffs.push({ field: `${spec.name}.instanceEnumerationScope`, expected: wantInstanceScope, actual: actualInstanceScope, severity: 'warning' })
      }
    }

    const { resolved: resolvedReviewers, missing: missingReviewers } = resolveReviewers(spec, reviewerMaps)
    if (missingReviewers.length) {
      diffs.push({
        field: `${spec.name}.reviewers`,
        expected: 'resolvable',
        actual: `unknown reviewer target(s): ${missingReviewers.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const wantReviewers = canonical(resolvedReviewers.reviewers)
      const actualReviewers = canonical(live.reviewers ?? [])
      if (wantReviewers !== actualReviewers) {
        diffs.push({ field: `${spec.name}.reviewers`, expected: wantReviewers, actual: actualReviewers, severity: 'warning' })
      }
      const wantFallback = canonical(resolvedReviewers.fallbackReviewers)
      const actualFallback = canonical(live.fallbackReviewers ?? [])
      if (wantFallback !== actualFallback) {
        diffs.push({ field: `${spec.name}.fallbackReviewers`, expected: wantFallback, actual: actualFallback, severity: 'warning' })
      }
    }

    const wantSettings = canonical(parseObject(spec.settings) ?? {})
    const actualSettings = canonical(live.settings ?? {})
    if (wantSettings !== actualSettings) {
      diffs.push({ field: `${spec.name}.settings`, expected: wantSettings, actual: actualSettings, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
