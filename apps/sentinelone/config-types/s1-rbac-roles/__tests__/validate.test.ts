import validate, {
  coercePermissionValue,
  extractRbacRoleSpecs,
  getNestedPath,
  readKeyValueMap,
  roleKey,
  setNestedPath,
} from '../validate'
import { mergePermissions, permissionsOf } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'sentinelone',
    customerId: 'cust-1',
    configTypeId: 's1-rbac-roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'sentinelone',
      entityType: 's1-rbac-roles',
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

describe('SentinelOne RBAC Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid role', async () => {
    const result = await validate(
      makeCtx([{ name: 'Role', fields: { name: 'Read Only Analyst', permissions: { 'policyEditing.edit': 'false' } } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('warns when no permission overrides are declared', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Bare Role' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_permission_overrides')).toBe(true)
  })

  it('rejects duplicate role names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'SOC Analyst' } },
        { name: 'b', fields: { name: 'soc analyst' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })

  it('readKeyValueMap tolerates object, array and "k=v" string shapes', () => {
    expect(readKeyValueMap({ a: 'true', b: 'false' })).toEqual({ a: 'true', b: 'false' })
    expect(readKeyValueMap([{ key: 'a', value: 'true' }])).toEqual({ a: 'true' })
    expect(readKeyValueMap('a=true\nb=false')).toEqual({ a: 'true', b: 'false' })
  })

  it('coercePermissionValue maps true/false/number/string', () => {
    expect(coercePermissionValue('true')).toBe(true)
    expect(coercePermissionValue('FALSE')).toBe(false)
    expect(coercePermissionValue('42')).toBe(42)
    expect(coercePermissionValue('edit')).toBe('edit')
  })

  it('setNestedPath / getNestedPath round-trip a dot-path key', () => {
    const obj: Record<string, unknown> = {}
    setNestedPath(obj, 'policyEditing.edit', true)
    expect(getNestedPath(obj, 'policyEditing.edit')).toBe(true)
    expect(getNestedPath(obj, 'policyEditing.missing')).toBeUndefined()
  })

  it('extractRbacRoleSpecs trims name and coerces permission values', () => {
    const specs = extractRbacRoleSpecs(
      makeCtx([{ name: 'r', fields: { name: '  SOC Analyst  ', permissions: { 'policyEditing.edit': 'true', maxUsers: '5' } } }])
        .canvas,
    )
    expect(specs[0].name).toBe('SOC Analyst')
    expect(specs[0].permissions['policyEditing.edit']).toBe(true)
    expect(specs[0].permissions.maxUsers).toBe(5)
    expect(roleKey('  SOC Analyst ')).toBe('soc analyst')
  })

  it('mergePermissions prefers a `permissions` sub-object and falls back to the whole detail', () => {
    const wrapped = mergePermissions({ permissions: { a: false, b: true } }, {
      sectionName: 's',
      name: 'Role',
      permissions: { a: true },
    })
    expect(wrapped).toEqual({ a: true, b: true })

    const flat = mergePermissions({ a: false }, { sectionName: 's', name: 'Role', permissions: { a: true } })
    expect(flat).toEqual({ a: true })
  })

  it('permissionsOf extracts the `permissions` sub-object or falls back to the whole object', () => {
    expect(permissionsOf({ permissions: { a: true } })).toEqual({ a: true })
    expect(permissionsOf({ a: true })).toEqual({ a: true })
  })
})
