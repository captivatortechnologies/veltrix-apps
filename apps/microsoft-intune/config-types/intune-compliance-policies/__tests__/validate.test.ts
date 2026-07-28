import validate, { extractComplianceSpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import {
  buildComplianceBody,
  buildScheduleActionsRequestFromPrior,
  capturePriorScheduledActions,
  hasAnyAssignment,
  PLATFORMS,
} from '../compliance'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-compliance-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-compliance-policies',
      items: [],
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000', azure_cloud: 'commercial' },
    platform: stubPlatform,
  }
}

describe('Intune Device Compliance Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a Windows policy with an assignment', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'p',
          fields: { policy_name: 'Corp Baseline', platform: 'windows', password_required: 'require', bitlocker_enabled: 'require', all_devices: true },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { platform: 'windows', all_devices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a supported platform', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'x', platform: 'symbian', all_devices: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_platform')).toBe(true)
  })

  it('rejects a negative grace period', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { policy_name: 'x', platform: 'ios', grace_period_hours: -4, all_users: true } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_grace_period')).toBe(true)
  })

  it('rejects duplicate policy names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { policy_name: 'Baseline', platform: 'windows', all_devices: true } },
        { name: 'b', fields: { policy_name: 'BASELINE', platform: 'ios', all_users: true } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('warns when a setting does not apply to the platform', async () => {
    const result = await validate(
      makeCtx([{ name: 'p', fields: { policy_name: 'iOS', platform: 'ios', bitlocker_enabled: 'require', all_devices: true } }]),
    )
    expect(result.valid).toBe(true)
    const warning = result.warnings.find((w) => w.code === 'ignored_setting')
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('bitlocker_enabled')
  })

  it('warns when a policy has no assignment target', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'Unassigned', platform: 'windows' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_assignment')).toBe(true)
  })

  it('extracts platform, settings, grace period and assignment groups', () => {
    const specs = extractComplianceSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            policy_name: '  Corp Baseline  ',
            platform: 'windows',
            password_required: 'require',
            password_minimum_length: '8',
            grace_period_hours: 24,
            non_compliance_action: 'retire',
            include_groups: 'g1, g2',
            exclude_groups: ['g3'],
            all_devices: true,
          },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Corp Baseline')
    expect(specs[0].platform).toBe('windows')
    expect(specs[0].settings.password_required).toBe(true)
    expect(specs[0].settings.password_minimum_length).toBe(8)
    expect(specs[0].gracePeriodHours).toBe(24)
    expect(specs[0].nonComplianceAction).toBe('retire')
    expect(specs[0].assignment.includeGroupIds).toEqual(['g1', 'g2'])
    expect(specs[0].assignment.excludeGroupIds).toEqual(['g3'])
    expect(specs[0].assignment.allDevices).toBe(true)
    expect(policyKey('  Corp Baseline ')).toBe('corp baseline')
  })

  it('builds an iOS body that maps password* to passcode* and omits encryption', () => {
    const specs = extractComplianceSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            policy_name: 'iOS Baseline',
            platform: 'ios',
            password_required: 'require',
            password_minimum_length: 6,
            storage_require_encryption: 'require',
            security_block_jailbroken: 'require',
          },
        },
      ]).canvas,
    )
    const body = buildComplianceBody(specs[0], { includeScheduledActions: true }) as Record<string, unknown>
    expect(body['@odata.type']).toBe(PLATFORMS.ios.odataType)
    expect(body.passcodeRequired).toBe(true)
    expect(body.passcodeMinimumLength).toBe(6)
    expect(body.passwordRequired).toBeUndefined()
    expect(body.storageRequireEncryption).toBeUndefined() // iOS has no such property
    expect(body.securityBlockJailbrokenDevices).toBe(true)
  })

  it('builds a Windows body with the required scheduled block action', () => {
    const specs = extractComplianceSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            policy_name: 'Win Baseline',
            platform: 'windows',
            password_required: 'require',
            storage_require_encryption: 'require',
            bitlocker_enabled: 'require',
            device_threat_protection_level: 'high',
            grace_period_hours: 24,
          },
        },
      ]).canvas,
    )
    const body = buildComplianceBody(specs[0], { includeScheduledActions: true }) as Record<string, unknown>
    expect(body['@odata.type']).toBe(PLATFORMS.windows.odataType)
    expect(body.passwordRequired).toBe(true)
    expect(body.storageRequireEncryption).toBe(true)
    expect(body.bitLockerEnabled).toBe(true)
    expect(body.deviceThreatProtectionRequiredSecurityLevel).toBe('high')

    const rules = body.scheduledActionsForRule as Array<Record<string, unknown>>
    expect(rules).toHaveLength(1)
    expect(rules[0].ruleName).toBe('PasswordRequired')
    const configs = rules[0].scheduledActionConfigurations as Array<Record<string, unknown>>
    expect(configs[0].actionType).toBe('block')
    expect(configs[0].gracePeriodHours).toBe(24)
  })

  it('appends a retire action when non_compliance_action is retire', () => {
    const specs = extractComplianceSpecs(
      makeCtx([{ name: 'p', fields: { policy_name: 'Retire', platform: 'macos', non_compliance_action: 'retire' } }]).canvas,
    )
    const body = buildComplianceBody(specs[0], { includeScheduledActions: true }) as Record<string, unknown>
    const rules = body.scheduledActionsForRule as Array<Record<string, unknown>>
    const configs = rules[0].scheduledActionConfigurations as Array<Record<string, unknown>>
    expect(configs).toHaveLength(2)
    expect(configs[0].actionType).toBe('block')
    expect(configs[1].actionType).toBe('retire')
  })

  it('omits securityBlockJailbrokenDevices for Android device owner (no such property)', () => {
    const specs = extractComplianceSpecs(
      makeCtx([
        {
          name: 'p',
          fields: {
            policy_name: 'DO',
            platform: 'androidDeviceOwner',
            password_required: 'require',
            security_block_jailbroken: 'require',
          },
        },
      ]).canvas,
    )
    const body = buildComplianceBody(specs[0], { includeScheduledActions: false }) as Record<string, unknown>
    expect(body['@odata.type']).toBe(PLATFORMS.androidDeviceOwner.odataType)
    expect(body.passwordRequired).toBe(true)
    // Device owner has no securityBlockJailbrokenDevices — it must NOT be sent.
    expect(body.securityBlockJailbrokenDevices).toBeUndefined()
  })

  it('still emits securityBlockJailbrokenDevices for Android work profile', () => {
    const specs = extractComplianceSpecs(
      makeCtx([{ name: 'p', fields: { policy_name: 'WP', platform: 'androidWorkProfile', security_block_jailbroken: 'require' } }]).canvas,
    )
    const body = buildComplianceBody(specs[0], { includeScheduledActions: false }) as Record<string, unknown>
    expect(body.securityBlockJailbrokenDevices).toBe(true)
  })

  it('captures and rebuilds prior scheduled actions for rollback, dropping server ids', () => {
    const captured = capturePriorScheduledActions([
      {
        ruleName: 'PasswordRequired',
        scheduledActionConfigurations: [
          { id: 'srv-1', actionType: 'block', gracePeriodHours: 48, notificationTemplateId: '', notificationMessageCCList: [] },
          { id: 'srv-2', actionType: 'retire', gracePeriodHours: 48 },
        ],
      },
    ])
    expect(captured).toHaveLength(1)
    expect(captured[0].ruleName).toBe('PasswordRequired')
    const configs = captured[0].scheduledActionConfigurations as Array<Record<string, unknown>>
    expect(configs).toHaveLength(2)
    expect(configs[0].actionType).toBe('block')
    expect(configs[0].gracePeriodHours).toBe(48)
    expect('id' in configs[0]).toBe(false) // server-managed id dropped
    expect(configs[1].gracePeriodHours).toBe(48)
    expect(configs[1].notificationTemplateId).toBe('') // defaulted
    expect(configs[1].notificationMessageCCList).toEqual([])

    const req = buildScheduleActionsRequestFromPrior(captured) as Record<string, unknown>
    expect(req.deviceComplianceScheduledActionForRules).toBe(captured)
  })

  it('capturePriorScheduledActions tolerates missing/empty input', () => {
    expect(capturePriorScheduledActions(undefined)).toEqual([])
    expect(capturePriorScheduledActions([])).toEqual([])
  })

  it('hasAnyAssignment is false only when no target is declared (drives assignment preservation)', () => {
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(false)
    expect(hasAnyAssignment({ includeGroupIds: ['g1'], excludeGroupIds: [], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: ['g2'], allDevices: false, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: true, allUsers: false })).toBe(true)
    expect(hasAnyAssignment({ includeGroupIds: [], excludeGroupIds: [], allDevices: false, allUsers: true })).toBe(true)
  })
})
