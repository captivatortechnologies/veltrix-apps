import validate, { extractAccountGroupSpecs, groupKey, parseMembers } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-account-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-account-groups',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { group_name: 'WinRotationGroup', safe_name: 'AppAccounts', group_platform_id: 'GroupPlatform' }

describe('CyberArk Account Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal group', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires group_name, safe_name and group_platform_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('group_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('safe_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('group_platform_id'))).toBe(true)
  })

  it('rejects malformed members JSON', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, members: '{bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('rejects a member missing account_name or safe_name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, members: JSON.stringify([{ account_name: 'svc' }]) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('accepts a well-formed members list', async () => {
    const members = JSON.stringify([{ account_name: 'svc-app01', safe_name: 'AppAccounts' }])
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, members } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate members within one group', async () => {
    const members = JSON.stringify([
      { account_name: 'svc-app01', safe_name: 'AppAccounts' },
      { account_name: 'svc-app01', safe_name: 'AppAccounts' },
    ])
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, members } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_member')).toBe(true)
  })

  it('rejects duplicate (safe, group name) pairs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields } },
        { name: 'b', fields: { ...validFields, group_name: validFields.group_name.toUpperCase() } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows the same group name in a different safe', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields } },
        { name: 'b', fields: { ...validFields, safe_name: 'OtherSafe' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('extracts specs and computes a stable key', () => {
    const specs = extractAccountGroupSpecs(makeCtx([{ name: 'a', fields: { ...validFields } }]).canvas)
    expect(specs[0].groupName).toBe('WinRotationGroup')
    expect(groupKey(specs[0])).toBe(groupKey({ safeName: 'appaccounts', groupName: 'winrotationgroup' }))
  })

  it('parseMembers returns [] for blank input', () => {
    const result = parseMembers('')
    expect(result.error).toBeNull()
    expect(result.value).toEqual([])
  })
})
