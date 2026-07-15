import validate, {
  extractSpaceSpecs,
  isProtectedSpaceId,
  toStringList,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'spaces',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'spaces',
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

describe('Elastic Security Spaces Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal space (id + name)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Space', fields: { id: 'security-ops', name: 'Security Operations' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-specified space', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Space',
          fields: {
            id: 'sec-ops',
            name: 'Security Ops',
            description: 'SOC workspace',
            solution: 'security',
            disabledFeatures: ['ml', 'apm'],
            initials: 'SO',
            color: '#0B64DD',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Id' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('id'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { id: 'nameless' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an id with invalid characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { id: 'Security Ops', name: 'Bad Id' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_id')).toBe(true)
  })

  it('rejects avatar initials longer than 2 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { id: 'ops', name: 'Ops', initials: 'ABC' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_initials')).toBe(true)
  })

  it('rejects a non-hex avatar color', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { id: 'ops', name: 'Ops', color: 'blue' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('rejects an unrecognised solution view', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { id: 'ops', name: 'Ops', solution: 'logging' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_solution')).toBe(true)
  })

  it('rejects a duplicate space id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { id: 'ops', name: 'Ops One' } },
        { name: 'sec2', fields: { id: 'ops', name: 'Ops Two' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_space')).toBe(true)
  })

  it('treats ids differing only in case as duplicates', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { id: 'ops', name: 'Ops One' } },
        { name: 'sec2', fields: { id: 'OPS', name: 'Ops Two' } },
      ]),
    )
    expect(result.valid).toBe(false)
    // The second id is also caught by invalid_id (uppercase), but the duplicate
    // rule must still fire on the lowercased key.
    expect(result.errors.some((e) => e.code === 'duplicate_space')).toBe(true)
  })

  it('allows updating the protected default space in place (name provided)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Space', fields: { id: 'default', name: 'Default' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'protected_default')).toBe(true)
  })

  it('rejects removing the protected default space (declared with no name)', async () => {
    const result = await validate(makeCtx([{ name: 'Space', fields: { id: 'default' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_default')).toBe(true)
  })
})

describe('extractSpaceSpecs', () => {
  it('trims fields, drops empty optionals, and normalizes disabledFeatures to a list', () => {
    const specs = extractSpaceSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'spaces',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            id: '  security-ops  ',
            name: '  Security Ops  ',
            description: '  ',
            solution: '',
            disabledFeatures: [' ml ', '', 'apm'],
            initials: '',
            color: '  #07C  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].id).toBe('security-ops')
    expect(specs[0].name).toBe('Security Ops')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].solution).toBeUndefined()
    expect(specs[0].initials).toBeUndefined()
    expect(specs[0].color).toBe('#07C')
    expect(specs[0].disabledFeatures).toEqual(['ml', 'apm'])
  })
})

describe('toStringList', () => {
  it('passes an array through, trimming and dropping blanks', () => {
    expect(toStringList([' ml ', '', 'apm'])).toEqual(['ml', 'apm'])
  })
  it('splits a comma/newline-separated string', () => {
    expect(toStringList('ml, apm\nsiem')).toEqual(['ml', 'apm', 'siem'])
  })
  it('returns an empty array for a non-list value', () => {
    expect(toStringList(undefined)).toEqual([])
    expect(toStringList(42)).toEqual([])
  })
})

describe('isProtectedSpaceId', () => {
  it('is true for the default space (case/space-insensitive)', () => {
    expect(isProtectedSpaceId('default')).toBe(true)
    expect(isProtectedSpaceId('  DEFAULT ')).toBe(true)
  })
  it('is false for any other space', () => {
    expect(isProtectedSpaceId('security-ops')).toBe(false)
    expect(isProtectedSpaceId(undefined)).toBe(false)
    expect(isProtectedSpaceId(null)).toBe(false)
  })
})
