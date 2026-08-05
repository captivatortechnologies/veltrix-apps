import validate from '../validate'
import {
  buildCustomRoleCreateBody,
  buildCustomRolePatchBody,
  customRoleKey,
  customRoleMatches,
  extractCustomRoleSpecs,
} from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sophos-central',
    customerId: 'cust-1',
    configTypeId: 'custom-roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sophos-central',
      entityType: 'custom-roles',
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

const validFields = {
  name: 'Endpoint Admin',
  description: 'Manages endpoint policy',
  principalType: 'user',
  permissionSets: ['central_admin', 'endpoint_product_admin'],
}

describe('Sophos Central Custom Roles Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed role', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, principalType and at least one permission set', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED')).toHaveLength(3)
  })

  it('rejects an unknown principalType', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, principalType: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PRINCIPAL_TYPE')).toBe(true)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: validFields }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('warns on a duplicate permission set within one item', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ...validFields, permissionSets: ['central_admin', 'central_admin'] } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_PERMISSION_SET')).toBe(true)
  })
})

describe('Sophos Central Custom Roles shared helpers', () => {
  it('customRoleKey trims and lower-cases', () => {
    expect(customRoleKey('  Endpoint Admin  ')).toBe('endpoint admin')
  })

  it('extractCustomRoleSpecs reads and splits permissionSets', () => {
    const specs = extractCustomRoleSpecs(
      makeCtx([{ name: 'e', fields: { name: ' Admin ', description: '', principalType: 'user', permissionSets: 'a,b' } }]).canvas,
    )
    expect(specs[0].name).toBe('Admin')
    expect(specs[0].permissionSets).toEqual(['a', 'b'])
  })

  it('buildCustomRoleCreateBody includes principalType', () => {
    const body = buildCustomRoleCreateBody({ itemName: 'x', name: 'Admin', description: 'd', principalType: 'user', permissionSets: ['a'] })
    expect(body).toEqual({ name: 'Admin', principalType: 'user', permissionSets: ['a'], description: 'd' })
  })

  it('buildCustomRolePatchBody omits principalType (immutable)', () => {
    const body = buildCustomRolePatchBody({ itemName: 'x', name: 'Admin', description: 'd', principalType: 'user', permissionSets: ['a'] })
    expect(body).toEqual({ name: 'Admin', permissionSets: ['a'], description: 'd' })
  })

  it('customRoleMatches compares name/description/permissionSets order-insensitively', () => {
    const spec = { itemName: 'x', name: 'Admin', description: 'd', principalType: 'user', permissionSets: ['b', 'a'] }
    expect(customRoleMatches(spec, { name: 'Admin', description: 'd', principalType: 'user', permissionSets: ['a', 'b'] })).toBe(true)
    expect(customRoleMatches(spec, { name: 'Admin', description: 'd', principalType: 'user', permissionSets: ['a'] })).toBe(false)
  })
})
