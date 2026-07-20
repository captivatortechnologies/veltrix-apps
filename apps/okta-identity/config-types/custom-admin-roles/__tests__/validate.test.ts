import validate, { extractRoleSpecs, isStandardRoleType, splitList } from '../validate'
import { findRoleByLabel, type RoleRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { LiveRole } from '../validate'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'custom-admin-roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'custom-admin-roles',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'okta-identity',
    entityType: 'custom-admin-roles',
    items: sections,
    sections,
    snapshot: {},
  }
}

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'Help Desk Lite',
    description: 'Read users and reset passwords',
    permissions: ['okta.users.read', 'okta.users.credentials.resetPassword'],
    ...over,
  }
}

describe('Okta Custom Admin Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid role with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Role', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects a missing label', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ label: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('label'))).toBe(true)
  })

  it('rejects a label that collides with a standard role type', async () => {
    for (const label of ['SUPER_ADMIN', 'super admin', 'Org_Admin']) {
      const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ label }) }]))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'standard_role')).toBe(true)
    }
  })

  it('rejects a missing description', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ description: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('description'))).toBe(true)
  })

  it('rejects a role with no permissions', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ permissions: [] }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('permissions'))).toBe(true)
  })

  it('warns (does not reject) on a suspicious permission name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ permissions: ['not-a-permission'] }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_permission')).toBe(true)
  })

  it('rejects a duplicate label (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ label: 'Auditor' }) },
        { name: 'sec2', fields: validFields({ label: 'auditor' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_label')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('trims fields and de-dupes permissions', () => {
    const specs = extractRoleSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            label: '  Auditor  ',
            description: '  Reads everything  ',
            permissions: ['okta.users.read', 'okta.users.read', ' okta.groups.read '],
          },
        },
      ]),
    )
    expect(specs[0].label).toBe('Auditor')
    expect(specs[0].description).toBe('Reads everything')
    expect(specs[0].permissions).toEqual(['okta.users.read', 'okta.groups.read'])
  })
})

describe('splitList', () => {
  it('handles arrays and delimited strings', () => {
    expect(splitList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(splitList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(42)).toEqual([])
  })
})

describe('isStandardRoleType', () => {
  it('matches standard role types (space or underscore, any case)', () => {
    expect(isStandardRoleType('SUPER_ADMIN')).toBe(true)
    expect(isStandardRoleType('help desk admin')).toBe(true)
    expect(isStandardRoleType('My Custom Role')).toBe(false)
  })
})

describe('findRoleByLabel', () => {
  it('matches an exact label and returns null otherwise', () => {
    const roles: LiveRole[] = [
      { id: 'cr0aaa', label: 'Auditor' },
      { id: 'cr0bbb', label: 'Help Desk Lite' },
    ]
    expect(findRoleByLabel(roles, 'Help Desk Lite')?.id).toBe('cr0bbb')
    expect(findRoleByLabel(roles, 'Nope')).toBe(null)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: RoleRollbackEntry | null = null
void _rollbackEntryType
