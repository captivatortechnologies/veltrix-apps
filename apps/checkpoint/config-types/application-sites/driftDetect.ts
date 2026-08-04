import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllApplicationSites } from './deploy'
import { applicationSiteKey, extractApplicationSiteSpecs, livePrimaryCategoryName, type LiveApplicationSite } from './validate'

/**
 * Detect drift between the deployed application-site configuration and the
 * live management database. Re-finds each declared site by name
 * (show-application-sites) and diffs the managed fields: a missing site or a
 * changed URL list is critical drift (it changes what traffic the object
 * matches); a changed category, regex flag, description, comment, color or
 * tag set is a warning. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractApplicationSiteSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllApplicationSites(client)
    const byName = new Map<string, LiveApplicationSite>(live.filter((s) => s.name).map((s) => [applicationSiteKey(s.name as string), s]))

    for (const spec of specs) {
      const found = byName.get(applicationSiteKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveUrlList = Array.isArray(found['url-list']) ? (found['url-list'] as string[]) : []
      if (!sameStringSet(liveUrlList, spec.urlList)) {
        diffs.push({
          field: `${label}.urlList`,
          expected: spec.urlList.join(', ') || '(none)',
          actual: liveUrlList.join(', ') || '(none)',
          severity: 'critical',
        })
      }
      const liveRegex = found['urls-defined-as-regular-expression'] ?? false
      if (liveRegex !== spec.urlsDefinedAsRegex) {
        diffs.push({
          field: `${label}.urlsDefinedAsRegex`,
          expected: spec.urlsDefinedAsRegex,
          actual: liveRegex,
          severity: 'warning',
        })
      }
      const liveCategory = livePrimaryCategoryName(found['primary-category'])
      if (spec.primaryCategory && liveCategory && liveCategory !== spec.primaryCategory) {
        diffs.push({ field: `${label}.primaryCategory`, expected: spec.primaryCategory, actual: liveCategory, severity: 'warning' })
      }
      if (spec.description || found.description) {
        const liveDescription = found.description ?? ''
        if (liveDescription !== spec.description) {
          diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescription, severity: 'warning' })
        }
      }
      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
      if (spec.color && found.color && found.color !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color, actual: found.color, severity: 'warning' })
      }
      const liveTags = liveTagNames(found.tags)
      if (!sameStringSet(liveTags, spec.tags)) {
        diffs.push({
          field: `${label}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
