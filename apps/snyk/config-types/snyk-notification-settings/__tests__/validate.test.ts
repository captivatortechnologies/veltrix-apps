import validate, { extractNotificationSpec, readBool, NOTIFICATION_SEVERITIES } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-notification-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-notification-settings',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

describe('Snyk Notification Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete notification settings item', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Notifications',
          fields: {
            new_issues_enabled: true,
            new_issues_severity: 'high',
            weekly_report_enabled: true,
            project_imported_enabled: true,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('accepts an item with no fields (severity defaults to high, all enabled)', async () => {
    const result = await validate(makeCtx([{ name: 'Notifications', fields: {} }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid new-issues severity', async () => {
    const result = await validate(makeCtx([{ name: 'Notifications', fields: { new_issues_severity: 'urgent' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects more than one item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { new_issues_severity: 'high' } },
        { name: 'b', fields: { new_issues_severity: 'low' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton_only')).toBe(true)
  })

  it('warns when all managed notifications are disabled', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Notifications',
          fields: {
            new_issues_enabled: false,
            weekly_report_enabled: false,
            project_imported_enabled: false,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'all_notifications_disabled')).toBe(true)
  })

  it('readBool + extractNotificationSpec behave', () => {
    expect(readBool(true, false)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool('yes', false)).toBe(true)
    expect(readBool(undefined, true)).toBe(true)

    const spec = extractNotificationSpec(
      makeCtx([{ name: 's', fields: { new_issues_enabled: 'true', new_issues_severity: 'CRITICAL' } }]).canvas,
    )
    expect(spec.newIssuesEnabled).toBe(true)
    expect(spec.newIssuesSeverity).toBe('critical')
    expect(spec.weeklyReportEnabled).toBe(true)
    expect(NOTIFICATION_SEVERITIES.includes('critical')).toBe(true)
  })
})
