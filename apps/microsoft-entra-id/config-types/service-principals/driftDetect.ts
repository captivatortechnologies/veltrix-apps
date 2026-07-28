import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  effectiveSsoMode,
  extractServicePrincipalSpecs,
  findByAppIdPath,
  normalizeList,
  type LiveServicePrincipal,
} from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractServicePrincipalSpecs(ctx.deployedConfig).filter((s) => s.appId)
  const diffs: Diffs = []

  for (const spec of specs) {
    const found = await client.getAll<LiveServicePrincipal>(findByAppIdPath(spec.appId))
    if (!found.ok) continue // Best-effort: a read failure asserts no drift for this SP.
    const live = found.items[0]
    if (!live) {
      diffs.push({ field: spec.appId, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }

    const liveEnabled = live.accountEnabled ?? true
    if (liveEnabled !== spec.accountEnabled) {
      diffs.push({
        field: `${spec.appId}.accountEnabled`,
        expected: String(spec.accountEnabled),
        actual: String(liveEnabled),
        severity: 'warning',
      })
    }

    const liveAssignReq = live.appRoleAssignmentRequired ?? false
    if (liveAssignReq !== spec.appRoleAssignmentRequired) {
      diffs.push({
        field: `${spec.appId}.appRoleAssignmentRequired`,
        expected: String(spec.appRoleAssignmentRequired),
        actual: String(liveAssignReq),
        severity: 'warning',
      })
    }

    const wantSso = effectiveSsoMode(spec)
    const liveSso = live.preferredSingleSignOnMode ?? ''
    if (wantSso !== liveSso) {
      diffs.push({
        field: `${spec.appId}.preferredSingleSignOnMode`,
        expected: wantSso || '(none)',
        actual: liveSso || '(none)',
        severity: 'warning',
      })
    }

    const liveHome = (live.homepage ?? '') as string
    if (liveHome !== spec.homepage) {
      diffs.push({
        field: `${spec.appId}.homepage`,
        expected: spec.homepage || '(none)',
        actual: liveHome || '(none)',
        severity: 'warning',
      })
    }

    const wantEmails = normalizeList(spec.notificationEmailAddresses)
    const liveEmails = normalizeList(live.notificationEmailAddresses)
    if (wantEmails !== liveEmails) {
      diffs.push({
        field: `${spec.appId}.notificationEmailAddresses`,
        expected: spec.notificationEmailAddresses.join(', ') || '(none)',
        actual: (live.notificationEmailAddresses ?? []).join(', ') || '(none)',
        severity: 'warning',
      })
    }

    // Live tags are the UNION of the SP's own tags and the backing application's
    // tags, so drift is a subset check: flag only tags we declared that are absent.
    const liveTagSet = new Set((live.tags ?? []).map((t) => t.toLowerCase()))
    const missingTags = spec.tags.filter((t) => !liveTagSet.has(t.toLowerCase()))
    if (missingTags.length) {
      diffs.push({
        field: `${spec.appId}.tags`,
        expected: spec.tags.join(', '),
        actual: (live.tags ?? []).join(', ') || '(none)',
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
