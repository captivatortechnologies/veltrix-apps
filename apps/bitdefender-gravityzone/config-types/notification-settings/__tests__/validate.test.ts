import validate from '../validate'
import { buildNotificationSettingsBody, extractNotificationSettingsSpecs, notificationSettingsKey, notificationSettingsMatch } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'bitdefender-gravityzone',
    customerId: 'cust-1',
    configTypeId: 'notification-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'bitdefender-gravityzone',
      entityType: 'notification-settings',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('GravityZone Notification Settings Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed declaration with a blank accountId', async () => {
    const result = await validate(makeCtx([{ name: 'n1', fields: { accountId: '', deleteAfter: 30 } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('warns when two declarations both leave accountId blank', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { accountId: '' } }, { name: 'b', fields: { accountId: '' } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_ACCOUNT')).toBe(true)
  })

  it('rejects deleteAfter below 1', async () => {
    const result = await validate(makeCtx([{ name: 'n1', fields: { accountId: '', deleteAfter: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'OUT_OF_RANGE')).toBe(true)
  })

  it('rejects deleteAfter above 365', async () => {
    const result = await validate(makeCtx([{ name: 'n1', fields: { accountId: '', deleteAfter: 400 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'OUT_OF_RANGE')).toBe(true)
  })

  it('rejects malformed notificationsSettings JSON', async () => {
    const result = await validate(makeCtx([{ name: 'n1', fields: { accountId: '', notificationsSettings: '{not an array}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects notificationsSettings that is a JSON object instead of an array', async () => {
    const result = await validate(makeCtx([{ name: 'n1', fields: { accountId: '', notificationsSettings: '{"type":"av"}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })
})

describe('GravityZone Notification Settings shared helpers', () => {
  it('notificationSettingsKey trims and lower-cases', () => {
    expect(notificationSettingsKey('  Account-1  ')).toBe('account-1')
  })

  it('extractNotificationSettingsSpecs reads only declared fields', () => {
    const specs = extractNotificationSettingsSpecs(makeCtx([{ name: 'n', fields: { accountId: '', includeDeviceFQDN: true, emailAddresses: 'a@x.com,b@x.com' } }]).canvas)
    expect(specs[0].includeDeviceFQDNDeclared).toBe(true)
    expect(specs[0].includeDeviceNameDeclared).toBe(false)
    expect(specs[0].emailAddresses).toEqual(['a@x.com', 'b@x.com'])
  })

  it('buildNotificationSettingsBody omits undeclared fields', () => {
    const specs = extractNotificationSettingsSpecs(makeCtx([{ name: 'n', fields: { accountId: '', deleteAfter: 30 } }]).canvas)
    const body = buildNotificationSettingsBody(specs[0], null)
    expect(body).toEqual({ deleteAfter: 30 })
  })

  it('notificationSettingsMatch only compares declared fields', () => {
    const specs = extractNotificationSettingsSpecs(makeCtx([{ name: 'n', fields: { accountId: '', deleteAfter: 30 } }]).canvas)
    expect(notificationSettingsMatch(specs[0], null, { deleteAfter: 30, includeDeviceFQDN: true })).toBe(true)
    expect(notificationSettingsMatch(specs[0], null, { deleteAfter: 60 })).toBe(false)
  })
})
