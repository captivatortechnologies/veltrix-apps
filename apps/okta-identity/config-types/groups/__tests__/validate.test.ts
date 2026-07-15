import validate, {
  coerceBoolean,
  extractGroupSpecs,
  isReservedGroupName,
  splitList,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'groups',
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

describe('Okta Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid group (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { name: 'Engineering' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid group with description and managed membership', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            name: 'Engineering',
            description: 'All engineers',
            manageMembership: true,
            memberUserIds: ['00u1', '00u2'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { description: 'no name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a description longer than 1024 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', description: 'x'.repeat(1025) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('description'))).toBe(true)
  })

  it('rejects the reserved built-in name "Everyone"', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Everyone' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects the reserved name case-insensitively ("everyone")', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'everyone' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering' } },
        { name: 'sec2', fields: { name: 'Engineering' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows two distinct group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering' } },
        { name: 'sec2', fields: { name: 'Sales' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when membership is managed but no members are listed', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', manageMembership: true, memberUserIds: [] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'membership_clears_all')).toBe(true)
  })

  it('warns when members are listed but membership is not managed', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'Engineering', manageMembership: false, memberUserIds: ['00u1'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'membership_ignored')).toBe(true)
  })
})

describe('extractGroupSpecs', () => {
  it('trims fields, coerces the checkbox and splits the member list', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'groups',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Engineering  ',
            description: '  ',
            manageMembership: 'true',
            memberUserIds: ['00u1', '00u1', '  00u2  '],
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Engineering')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].manageMembership).toBe(true)
    // Duplicates removed, values trimmed.
    expect(specs[0].memberUserIds).toEqual(['00u1', '00u2'])
  })

  it('defaults manageMembership to false and members to empty', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'okta-identity',
      entityType: 'groups',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Engineering' } }],
      snapshot: {},
    })
    expect(specs[0].manageMembership).toBe(false)
    expect(specs[0].memberUserIds).toHaveLength(0)
  })
})

describe('coerceBoolean', () => {
  it('keeps real booleans', () => {
    expect(coerceBoolean(true, false)).toBe(true)
    expect(coerceBoolean(false, true)).toBe(false)
  })
  it('coerces string / number forms', () => {
    expect(coerceBoolean('true', false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean(1, false)).toBe(true)
    expect(coerceBoolean(0, true)).toBe(false)
  })
  it('falls back to the default for unrecognized input', () => {
    expect(coerceBoolean(undefined, true)).toBe(true)
    expect(coerceBoolean('nope', false)).toBe(false)
  })
})

describe('splitList', () => {
  it('accepts an array', () => {
    expect(splitList(['a', ' b ', ''])).toEqual(['a', 'b'])
  })
  it('splits a comma/newline string', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
  })
  it('returns empty for other types', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList(42)).toEqual([])
  })
})

describe('isReservedGroupName', () => {
  it('flags Everyone in any case', () => {
    expect(isReservedGroupName('Everyone')).toBe(true)
    expect(isReservedGroupName('  everyone  ')).toBe(true)
  })
  it('allows a normal group name', () => {
    expect(isReservedGroupName('Engineering')).toBe(false)
  })
})
