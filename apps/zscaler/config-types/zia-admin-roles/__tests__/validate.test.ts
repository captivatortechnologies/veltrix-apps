import validate, { extractAdminRoleSpecs, parseRoleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-admin-roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-admin-roles',
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

describe('ZIA Admin Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid admin role', async () => {
    const result = await validate(
      makeCtx([{ name: 'Admin Role', fields: { name: 'Helpdesk', rank: 7 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a role with a well-formed role_json object', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Admin Role',
          fields: {
            name: 'Auditor',
            rank: 5,
            role_json: '{"policyAccess":"READ_ONLY","dashboardAccess":"READ_ONLY"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { rank: 7 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Auditor' } },
        { name: 'b', fields: { name: 'auditor' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_admin_role')).toBe(true)
  })

  it('rejects an invalid (non-object) role_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Broken', role_json: '{not valid json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_role_json')).toBe(true)
  })

  it('rejects a role_json that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ArrayRole', role_json: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_role_json')).toBe(true)
  })

  it('rejects a non-integer rank', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'BadRank', rank: 'abc' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rank')).toBe(true)
  })

  it('defaults rank to 7 and trims the name during extraction', () => {
    const specs = extractAdminRoleSpecs(
      makeCtx([{ name: 'Admin Role', fields: { name: '  Helpdesk  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('Helpdesk')
    expect(specs[0].rank).toBe(7)
    expect(specs[0].roleJson).toBeUndefined()
  })

  it('parseRoleObject accepts objects and rejects arrays / primitives', () => {
    expect(parseRoleObject('{"policyAccess":"READ_WRITE"}')).toEqual({ policyAccess: 'READ_WRITE' })
    expect(parseRoleObject('[]')).toBeNull()
    expect(parseRoleObject('"str"')).toBeNull()
    expect(parseRoleObject('nope')).toBeNull()
  })
})
