import validate, { extractUserTypeSpecs } from '../validate'
import { buildUserTypeBody, findUserTypeByName, type UserTypeRollbackEntry } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { LiveUserType } from '../validate'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'user-types',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'user-types',
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
    entityType: 'user-types',
    items: sections,
    sections,
    snapshot: {},
  }
}

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'Contractor', displayName: 'Contractor', description: 'External contractors', ...over }
}

describe('Okta User Types Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid user type', async () => {
    const result = await validate(makeCtx([{ name: 'Type', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid machine name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '1Bad Name' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: 'x'.repeat(256) }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing display name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ displayName: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('displayName'))).toBe(true)
  })

  it('accepts a user type without a description', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ description: '' }) }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ name: 'Contractor' }) },
        { name: 'sec2', fields: validFields({ name: 'contractor' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractUserTypeSpecs', () => {
  it('trims fields and drops a blank description', () => {
    const specs = extractUserTypeSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: '  Contractor  ', displayName: '  Contractor  ', description: '   ' } }]),
    )
    expect(specs[0].name).toBe('Contractor')
    expect(specs[0].displayName).toBe('Contractor')
    expect(specs[0].description).toBeUndefined()
  })
})

describe('buildUserTypeBody', () => {
  it('always sends name/displayName and an empty description when absent', () => {
    expect(buildUserTypeBody({ sectionName: 's', name: 'Contractor', displayName: 'Contractor' })).toEqual({
      name: 'Contractor',
      displayName: 'Contractor',
      description: '',
    })
  })

  it('includes the description when present', () => {
    expect(
      buildUserTypeBody({ sectionName: 's', name: 'Emp', displayName: 'Employee', description: 'Staff' }),
    ).toEqual({ name: 'Emp', displayName: 'Employee', description: 'Staff' })
  })
})

describe('findUserTypeByName', () => {
  it('matches an exact name and returns null otherwise', () => {
    const types: LiveUserType[] = [
      { id: 'otydefault', name: 'user', displayName: 'User', default: true },
      { id: 'oty1', name: 'Contractor', displayName: 'Contractor' },
    ]
    expect(findUserTypeByName(types, 'Contractor')?.id).toBe('oty1')
    expect(findUserTypeByName(types, 'Nope')).toBe(null)
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: UserTypeRollbackEntry | null = null
void _rollbackEntryType
