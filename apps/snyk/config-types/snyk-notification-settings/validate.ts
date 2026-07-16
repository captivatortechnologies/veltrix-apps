import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk notification settings — a SINGLETON org setting (v1 API).
//
// The org has exactly one notification-settings object; the v1 API exposes it at
// GET/PUT /org/{org_id}/notification-settings as a plain-JSON map keyed by
// notification type (new-issues-remediations, weekly-report, project-imported,
// test-limit, ...). PUT REPLACES the whole object, so the deploy handler
// read-merge-PUTs to preserve keys this config type does not manage. The canvas
// therefore carries exactly one (non-repeatable) item.
// =============================================================================

/** Severity levels accepted for the "new issues" notification. */
export const NOTIFICATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export interface NotificationSpec {
  sectionName: string
  newIssuesEnabled: boolean
  newIssuesSeverity: string
  weeklyReportEnabled: boolean
  projectImportedEnabled: boolean
}

/**
 * The live v1 notification-settings object. Only the keys this config type
 * manages are typed; unmanaged notification types (e.g. test-limit) are carried
 * through the index signature so they survive the read-merge-PUT.
 */
export interface LiveNotificationSettings {
  'new-issues-remediations'?: { enabled?: boolean; issueSeverity?: string; issueType?: string }
  'weekly-report'?: { enabled?: boolean }
  'project-imported'?: { enabled?: boolean }
  [key: string]: unknown
}

/** Read a checkbox/boolean-ish field, falling back to `fallback` when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/**
 * A notification-settings canvas holds a single item. Extract it (or defaults:
 * everything enabled, severity "high").
 */
export function extractNotificationSpec(canvas: CanvasSnapshot): NotificationSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  const rawSeverity =
    typeof fields.new_issues_severity === 'string' ? fields.new_issues_severity.trim().toLowerCase() : ''
  return {
    sectionName: section?.name ?? 'Notification Settings',
    newIssuesEnabled: readBool(fields.new_issues_enabled, true),
    newIssuesSeverity: rawSeverity || 'high',
    weeklyReportEnabled: readBool(fields.weekly_report_enabled, true),
    projectImportedEnabled: readBool(fields.project_imported_enabled, true),
  }
}

/**
 * Validate notification settings: exactly one item is expected (it is a
 * singleton org setting), and the "new issues" severity must be one of the
 * accepted levels. Warn when every managed notification is turned off.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no notification settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'Notification settings is a single org-wide setting — declare only one item',
      code: 'singleton_only',
    })
  }

  const spec = extractNotificationSpec(ctx.canvas)
  if (!NOTIFICATION_SEVERITIES.includes(spec.newIssuesSeverity as NotificationSeverity)) {
    errors.push({
      field: `${spec.sectionName}.new_issues_severity`,
      message: `Invalid new-issues severity "${spec.newIssuesSeverity}" — must be one of: ${NOTIFICATION_SEVERITIES.join(', ')}`,
      code: 'invalid_severity',
    })
  }

  if (!spec.newIssuesEnabled && !spec.weeklyReportEnabled && !spec.projectImportedEnabled) {
    warnings.push({
      field: spec.sectionName,
      message: 'All managed notifications are disabled — members will receive no new-issue, weekly-report or import notifications',
      code: 'all_notifications_disabled',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
