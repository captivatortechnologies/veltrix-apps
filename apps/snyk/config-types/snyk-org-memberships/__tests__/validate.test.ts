import validate, { extractMembershipSpecs, membershipKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-org-memberships',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-org-memberships',
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

const valid = { user_id: 'user-uuid-1', email: 'dev@example.com', role_id: 'role-uuid-1' }

describe('Snyk Org Memberships Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid membership', async () => {
    const result = await validate(makeCtx([{ name: 'M', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a user id', async () => {
    const result = await validate(makeCtx([{ name: 'M', fields: { role_id: 'r' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('user_id'))).toBe(true)
  })

  it('requires an org role id', async () => {
    const result = await validate(makeCtx([{ name: 'M', fields: { user_id: 'u' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('role_id'))).toBe(true)
  })

  it('allows a membership with no email (optional)', async () => {
    const result = await validate(makeCtx([{ name: 'M', fields: { user_id: 'u', role_id: 'r' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate user ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { user_id: 'user-1', role_id: 'r' } },
        { name: 'b', fields: { user_id: 'USER-1', role_id: 'r' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_membership')).toBe(true)
  })

  it('helpers behave', () => {
    expect(membershipKey('  USER-1 ')).toBe('user-1')

    const spec = extractMembershipSpecs(
      makeCtx([{ name: 's', fields: { user_id: '  user-1  ', email: '  a@b.com  ', role_id: '  r1  ' } }]).canvas,
    )[0]
    expect(spec.userId).toBe('user-1')
    expect(spec.email).toBe('a@b.com')
    expect(spec.roleId).toBe('r1')
  })
})
