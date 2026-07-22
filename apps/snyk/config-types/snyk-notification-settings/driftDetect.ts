import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { attachDriftActor, veltrixActorLogins } from '../../lib/snykAuditLog'
import { readNotificationSettings } from './deploy'
import { extractNotificationSpec } from './validate'

/** Snyk audit event-name prefixes for org notification/settings changes (best-effort attribution). */
const NOTIFICATION_EVENT_PREFIXES = ['org.notification_settings', 'org.notification', 'org.settings']

/**
 * Detect drift between the deployed notification settings and the live org:
 * compare the four managed values to their deployed values. A value mismatch is
 * a warning; an unreachable API is critical. Severity is only compared while
 * new-issue notifications are enabled (it is meaningless otherwise).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built
  if (!client.hasOrg) return { hasDrift: false, diffs: [] }

  const spec = extractNotificationSpec(ctx.deployedConfig)

  try {
    const live = await readNotificationSettings(client)
    const liveNewIssuesEnabled = live?.['new-issues-remediations']?.enabled ?? false
    const liveNewIssuesSeverity = live?.['new-issues-remediations']?.issueSeverity ?? ''
    const liveWeeklyReportEnabled = live?.['weekly-report']?.enabled ?? false
    const liveProjectImportedEnabled = live?.['project-imported']?.enabled ?? false

    if (liveNewIssuesEnabled !== spec.newIssuesEnabled) {
      diffs.push({
        field: 'new_issues_enabled',
        expected: String(spec.newIssuesEnabled),
        actual: String(liveNewIssuesEnabled),
        severity: 'warning',
      })
    }
    if (spec.newIssuesEnabled && liveNewIssuesSeverity !== spec.newIssuesSeverity) {
      diffs.push({
        field: 'new_issues_severity',
        expected: spec.newIssuesSeverity,
        actual: liveNewIssuesSeverity || '(unset)',
        severity: 'warning',
      })
    }
    if (liveWeeklyReportEnabled !== spec.weeklyReportEnabled) {
      diffs.push({
        field: 'weekly_report_enabled',
        expected: String(spec.weeklyReportEnabled),
        actual: String(liveWeeklyReportEnabled),
        severity: 'warning',
      })
    }
    if (liveProjectImportedEnabled !== spec.projectImportedEnabled) {
      diffs.push({
        field: 'project_imported_enabled',
        expected: String(spec.projectImportedEnabled),
        actual: String(liveProjectImportedEnabled),
        severity: 'warning',
      })
    }

    // Org-singleton: attribute the notification setting change ("who changed it + when") — best-effort.
    await attachDriftActor(client, diffs, {
      eventPrefixes: NOTIFICATION_EVENT_PREFIXES,
      excludeActorLogins: veltrixActorLogins(ctx.credential),
    })
  } catch (error) {
    diffs.push({
      field: 'snyk',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
