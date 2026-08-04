import validate, { extractVaultGroupSpecs, groupMemberKey, parseGroupMembers, vaultGroupKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cyberark',
    customerId: 'cust-1',
    configTypeId: 'cyberark-vault-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cyberark',
      entityType: 'cyberark-vault-groups',
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

const validFields = { group_name: 'UnixAdmins' }

describe('CyberArk Vault Groups Validate Handler', () => {
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

  it('requires a group_name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('group_name'))).toBe(true)
  })

  it('rejects a member with an invalid member_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...validFields, members: JSON.stringify([{ member_id: 'x', member_type: 'other' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('requires domain_name when member_type is domain', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { ...validFields, members: JSON.stringify([{ member_id: 'x', member_type: 'domain' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_members')).toBe(true)
  })

  it('accepts a well-formed vault member and a well-formed domain member', async () => {
    const members = JSON.stringify([
      { member_id: 'svc-app01', member_type: 'vault' },
      { member_id: 'jdoe', member_type: 'domain', domain_name: 'corp.local' },
    ])
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, members } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate group names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { group_name: 'Admins' } },
        { name: 'b', fields: { group_name: 'admins' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('extracts specs and computes stable keys', () => {
    const specs = extractVaultGroupSpecs(makeCtx([{ name: 'a', fields: { group_name: '  UnixAdmins  ' } }]).canvas)
    expect(specs[0].groupName).toBe('UnixAdmins')
    expect(vaultGroupKey(specs[0])).toBe(vaultGroupKey({ groupName: 'unixadmins' }))
  })

  it('parseGroupMembers returns [] for blank input', () => {
    const result = parseGroupMembers('')
    expect(result.error).toBeNull()
    expect(result.value).toEqual([])
  })

  it('groupMemberKey is case-insensitive', () => {
    expect(groupMemberKey({ memberId: 'JDoe', memberType: 'Vault' })).toBe(groupMemberKey({ memberId: 'jdoe', memberType: 'vault' }))
  })
})
