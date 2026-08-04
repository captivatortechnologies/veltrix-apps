import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listGroups, listProfiles, readProfile, resolveGroupIds } from './deploy'
import {
  CONTENT_CATEGORY_FLAGS,
  PRIVACY_CATEGORY_FLAGS,
  SECURITY_CATEGORY_FLAGS,
  byName,
  extractDnsFilteringProfileSpecs,
  profileKey,
  selectedFlags,
  setSignature,
  type NamedRef,
} from './_shared'

/**
 * Detect drift between the deployed DNS Filtering Profile configuration and
 * the live Twingate tenant. Re-finds each declared profile by name and diffs
 * priority, fallback method, allow/deny domain lists, Group access and every
 * content/security/privacy category flag; a missing profile is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDnsFilteringProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listProfiles(client)
    const byNameMap = new Map(live.filter((p) => p.name).map((p) => [profileKey(p.name as string), p]))

    const needsGroups = specs.some((s) => s.groupNames.length > 0)
    const groupsByName = needsGroups ? byName(await listGroups(client)) : new Map<string, NamedRef>()

    for (const spec of specs) {
      const label = spec.name
      const push = (suffix: string, expected: unknown, actual: unknown) =>
        diffs.push({ field: `${label}.${suffix}`, expected, actual, severity: 'warning' })

      const found = byNameMap.get(profileKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const full = await readProfile(client, found.id)

      if ((full.priority ?? 1) !== spec.priority) push('priority', spec.priority, full.priority ?? 'not set')
      if ((full.fallbackMethod ?? 'STRICT') !== spec.fallbackMethod) {
        push('fallback_method', spec.fallbackMethod, full.fallbackMethod ?? 'not set')
      }
      if (setSignature(full.allowedDomains ?? []) !== setSignature(spec.allowedDomains)) {
        push('allowed_domains', spec.allowedDomains.join(', ') || '(none)', (full.allowedDomains ?? []).join(', ') || '(none)')
      }
      if (setSignature(full.deniedDomains ?? []) !== setSignature(spec.deniedDomains)) {
        push('denied_domains', spec.deniedDomains.join(', ') || '(none)', (full.deniedDomains ?? []).join(', ') || '(none)')
      }

      let declaredGroupIds: string[] = []
      try {
        declaredGroupIds = resolveGroupIds(spec, label, groupsByName)
      } catch (e) {
        push('group_names', spec.groupNames.join(', '), e instanceof Error ? e.message : 'not found in Twingate')
        declaredGroupIds = []
      }
      if (declaredGroupIds.length > 0 || spec.groupNames.length > 0) {
        const liveGroupIds = (full.groups?.edges ?? [])
          .map((e) => e?.node?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        if (setSignature(declaredGroupIds) !== setSignature(liveGroupIds)) {
          push('group_names', `${declaredGroupIds.length} group(s)`, `${liveGroupIds.length} group(s) in Twingate`)
        }
      }

      diffCategory(push, 'content_categories', spec.contentFlags, selectedFlags(full.contentCategoryConfig, CONTENT_CATEGORY_FLAGS))
      diffCategory(push, 'security_categories', spec.securityFlags, selectedFlags(full.securityCategoryConfig, SECURITY_CATEGORY_FLAGS))
      diffCategory(push, 'privacy_categories', spec.privacyFlags, selectedFlags(full.privacyCategoryConfig, PRIVACY_CATEGORY_FLAGS))
    }
  } catch (error) {
    diffs.push({
      field: 'twingate',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffCategory(
  push: (suffix: string, expected: unknown, actual: unknown) => void,
  field: string,
  declared: string[],
  live: string[],
): void {
  if (setSignature(declared) !== setSignature(live)) {
    push(field, declared.join(', ') || '(none)', live.join(', ') || '(none)')
  }
}
