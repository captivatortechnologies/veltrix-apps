import validate, {
  buildPermissionObject,
  enabledPermissions,
  extractSafeMemberSpecs,
  memberKey,
  SAFE_MEMBER_PERMISSIONS,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-safe-members',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-safe-members',
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

describe('CyberArk Safe Members Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid member', async () => {
    const result = await validate(
      makeCtx([
        { name: 'M', fields: { safe_name: 'App-Prod', member_name: 'svc_app', member_type: 'User', permissions: ['useAccounts', 'listAccounts'] } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires safe, member and at least one permission', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { permissions: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('safe_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('member_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('permissions'))).toBe(true)
  })

  it('rejects an unsupported member type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { safe_name: 'S', member_name: 'm', member_type: 'Robot', permissions: ['useAccounts'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_member_type')).toBe(true)
  })

  it('rejects a non-positive membership expiration', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { safe_name: 'S', member_name: 'm', permissions: ['useAccounts'], membership_expiration: -5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expiration')).toBe(true)
  })

  it('rejects duplicate (safe, member) pairs case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { safe_name: 'App', member_name: 'svc', permissions: ['useAccounts'] } },
        { name: 'b', fields: { safe_name: 'app', member_name: 'SVC', permissions: ['listAccounts'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_member')).toBe(true)
  })

  it('filters out unknown permission keys and defaults searchIn/type', () => {
    const specs = extractSafeMemberSpecs(
      makeCtx([{ name: 's', fields: { safe_name: 'S', member_name: 'm', permissions: ['useAccounts', 'bogusPerm'] } }]).canvas,
    )
    expect(specs[0].permissions).toEqual(['useAccounts'])
    expect(specs[0].searchIn).toBe('Vault')
    expect(specs[0].memberType).toBe('User')
    expect(memberKey(specs[0])).toBe(memberKey({ safeName: 's', memberName: 'M' }))
  })

  it('expands and reads back the permission object', () => {
    const obj = buildPermissionObject(['useAccounts', 'listAccounts'])
    expect(obj.useAccounts).toBe(true)
    expect(obj.listAccounts).toBe(true)
    expect(obj.deleteAccounts).toBe(false)
    expect(Object.keys(obj)).toHaveLength(SAFE_MEMBER_PERMISSIONS.length)
    expect(enabledPermissions(obj).sort()).toEqual(['listAccounts', 'useAccounts'])
  })
})
