import validate, { extractPopulationSpecs, splitList } from '../validate'
import { buildPopulationBody, stripReadOnlyPopulationFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'populations',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'populations',
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
    toolType: 'ping-identity',
    entityType: 'populations',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('PingOne Populations Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal population (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Pop', fields: { name: 'Employees' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-populated population', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Pop',
          fields: {
            name: 'Contractors',
            description: 'External contractors',
            default: false,
            preferredLanguage: 'en',
            alternativeIdentifiers: ['employeeId', 'badgeNumber'],
            passwordPolicyId: 'pwd-policy-1',
            defaultIdentityProviderId: 'idp-1',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'No name here' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(129) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate population name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Employees' } },
        { name: 'sec2', fields: { name: 'employees' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts the same population declared once even with a name at the exact length cap', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(128) } }]))
    expect(result.valid).toBe(true)
  })
})

describe('extractPopulationSpecs', () => {
  it('trims fields and drops blank optional values', () => {
    const specs = extractPopulationSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  Employees  ',
            description: '   ',
            default: true,
            preferredLanguage: '  ',
            alternativeIdentifiers: [],
            passwordPolicyId: '   ',
            defaultIdentityProviderId: '   ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('Employees')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].default).toBe(true)
    expect(specs[0].preferredLanguage).toBeUndefined()
    expect(specs[0].alternativeIdentifiers).toEqual([])
    expect(specs[0].passwordPolicyId).toBeUndefined()
    expect(specs[0].defaultIdentityProviderId).toBeUndefined()
  })

  it('defaults default to false when unset', () => {
    const specs = extractPopulationSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'Employees' } }]))
    expect(specs[0].default).toBe(false)
  })

  it('carries through alternativeIdentifiers, passwordPolicyId and defaultIdentityProviderId when set', () => {
    const specs = extractPopulationSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: 'Contractors',
            alternativeIdentifiers: ['employeeId', ' badgeNumber '],
            passwordPolicyId: 'pwd-policy-1',
            defaultIdentityProviderId: 'idp-1',
          },
        },
      ]),
    )
    expect(specs[0].alternativeIdentifiers).toEqual(['employeeId', 'badgeNumber'])
    expect(specs[0].passwordPolicyId).toBe('pwd-policy-1')
    expect(specs[0].defaultIdentityProviderId).toBe('idp-1')
  })
})

describe('splitList', () => {
  it('trims and drops empty entries from an array', () => {
    expect(splitList(['a', ' b ', '', '  '])).toEqual(['a', 'b'])
  })

  it('splits a comma/newline-delimited string', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for null/undefined/non-string-non-array', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList(null)).toEqual([])
    expect(splitList(42)).toEqual([])
  })
})

describe('buildPopulationBody', () => {
  it('always sends name and default, and omits blank optional fields', () => {
    const body = buildPopulationBody({
      sectionName: 's',
      name: 'Employees',
      default: false,
      alternativeIdentifiers: [],
    })
    expect(body).toEqual({ name: 'Employees', default: false })
  })

  it('includes description, preferredLanguage, alternativeIdentifiers and passwordPolicy when set', () => {
    const body = buildPopulationBody({
      sectionName: 's',
      name: 'Contractors',
      description: 'External contractors',
      default: true,
      preferredLanguage: 'en',
      alternativeIdentifiers: ['employeeId', 'badgeNumber'],
      passwordPolicyId: 'pwd-policy-1',
    })
    expect(body).toEqual({
      name: 'Contractors',
      default: true,
      description: 'External contractors',
      preferredLanguage: 'en',
      alternativeIdentifiers: ['employeeId', 'badgeNumber'],
      passwordPolicy: { id: 'pwd-policy-1' },
    })
  })

  it('never includes defaultIdentityProviderId in the population body (it is a separate sub-resource call)', () => {
    const body = buildPopulationBody({
      sectionName: 's',
      name: 'Employees',
      default: false,
      alternativeIdentifiers: [],
      defaultIdentityProviderId: 'idp-1',
    })
    expect(body.defaultIdentityProviderId).toBeUndefined()
    expect(body.defaultIdentityProvider).toBeUndefined()
  })
})

describe('stripReadOnlyPopulationFields', () => {
  it('removes id/environment/createdAt/updatedAt/_links/userCount but keeps the rest', () => {
    const stripped = stripReadOnlyPopulationFields({
      id: 'pop123',
      name: 'Employees',
      description: 'All employees',
      default: true,
      environment: { id: 'env-1' },
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
      userCount: 42,
      _links: { self: {} },
    })
    expect(stripped).toEqual({
      name: 'Employees',
      description: 'All employees',
      default: true,
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.userCount).toBeUndefined()
  })
})
