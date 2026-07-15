import validate, {
  extractRoleSpecs,
  normalizePermissionStrings,
  isSystemRole,
  livePermissionStrings,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'roles',
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

describe('Tenable Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid role', async () => {
    const result = await validate(
      makeCtx([{ name: 'Role', fields: { name: 'Auditor', permissionStrings: ['CanView', 'CanScan'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a role with a comma/newline permissionStrings string', async () => {
    const result = await validate(
      makeCtx([
        { name: 'Role', fields: { name: 'Auditor', description: 'Read only', permissionStrings: 'CanView, CanScan' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { permissionStrings: ['CanView'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects missing permission strings', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Auditor' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('permissionStrings'))).toBe(true)
  })

  it('rejects an empty permissionStrings list', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Auditor', permissionStrings: ['', '  '] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('permissionStrings'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256), permissionStrings: ['CanView'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a permission string containing a space', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Auditor', permissionStrings: ['Can Scan'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_permission')).toBe(true)
  })

  it('rejects a permission string starting with a digit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Auditor', permissionStrings: ['1CanScan'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_permission')).toBe(true)
  })

  it('rejects a duplicate role name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Auditor', permissionStrings: ['CanView'] } },
        { name: 'sec2', fields: { name: 'auditor', permissionStrings: ['CanScan'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('warns on a reserved built-in role name but stays valid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Administrator', permissionStrings: ['CanView'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'reserved_role_name')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('trims fields, drops empty description and de-duplicates permission strings', () => {
    const specs = extractRoleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'roles',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Auditor  ',
            description: '  ',
            permissionStrings: ['  CanView  ', 'CanScan', 'CanView'],
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Auditor')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].permissionStrings).toEqual(['CanView', 'CanScan'])
  })
})

describe('normalizePermissionStrings', () => {
  it('splits a comma/newline string, preserving case and dropping empties', () => {
    expect(normalizePermissionStrings('CanView,\nCanScan , ')).toEqual(['CanView', 'CanScan'])
  })
  it('de-duplicates an array while preserving order', () => {
    expect(normalizePermissionStrings(['CanScan', 'CanView', 'CanScan'])).toEqual(['CanScan', 'CanView'])
  })
  it('returns an empty list for a non-string/array value', () => {
    expect(normalizePermissionStrings(undefined)).toHaveLength(0)
  })
})

describe('isSystemRole', () => {
  it('is true for a SYSTEM role (any case)', () => {
    expect(isSystemRole({ type: 'SYSTEM' })).toBe(true)
    expect(isSystemRole({ type: 'system' })).toBe(true)
  })
  it('is false for a CUSTOM role or a role with no type', () => {
    expect(isSystemRole({ type: 'CUSTOM' })).toBe(false)
    expect(isSystemRole({})).toBe(false)
  })
})

describe('livePermissionStrings', () => {
  it('reads role_permission_strings when present', () => {
    expect(livePermissionStrings({ role_permission_strings: ['CanView', 'CanScan'] })).toEqual([
      'CanView',
      'CanScan',
    ])
  })
  it('falls back to permissions', () => {
    expect(livePermissionStrings({ permissions: ['CanView'] })).toEqual(['CanView'])
  })
  it('returns an empty list when neither is present', () => {
    expect(livePermissionStrings({})).toHaveLength(0)
  })
})
