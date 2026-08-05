import validate, { extractGroupSpecs, groupKey, parseCustomData } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
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

describe('PingOne Groups Validate Handler', () => {
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

  it('validates a valid group with every field set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            name: 'Engineering',
            description: 'All engineers',
            populationId: 'pop-1',
            userFilter: 'email sw "admin"',
            externalId: 'ext-123',
            customDataJson: '{"department":"Engineering"}',
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

  it('rejects a name longer than 256 characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(257) } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('name'))).toBe(true)
  })

  it('accepts a name exactly at the 256 character cap', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate (name, population) pair - both unscoped', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering' } },
        { name: 'sec2', fields: { name: 'Engineering' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('rejects a duplicate (name, population) pair - both scoped to the same population', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering', populationId: 'pop-1' } },
        { name: 'sec2', fields: { name: 'Engineering', populationId: 'pop-1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows the same name in two different populations', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering', populationId: 'pop-1' } },
        { name: 'sec2', fields: { name: 'Engineering', populationId: 'pop-2' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('allows the same name once scoped to a population and once unscoped', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Engineering' } },
        { name: 'sec2', fields: { name: 'Engineering', populationId: 'pop-1' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
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

  it('rejects malformed customDataJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', customDataJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_custom_data')).toBe(true)
  })

  it('rejects a customDataJson array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', customDataJson: '["a","b"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_custom_data')).toBe(true)
  })

  it('rejects a customDataJson primitive', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', customDataJson: '"just a string"' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_custom_data')).toBe(true)
  })

  it('accepts a valid customDataJson object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Engineering', customDataJson: '{"costCenter":"1234"}' } }]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractGroupSpecs', () => {
  it('trims fields and normalizes blanks to undefined', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'ping-identity',
      entityType: 'groups',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Engineering  ',
            description: '  ',
            populationId: '  pop-1  ',
            userFilter: '',
            externalId: undefined,
            customDataJson: '  {"a":1}  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Engineering')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].populationId).toBe('pop-1')
    expect(specs[0].userFilter).toBeUndefined()
    expect(specs[0].externalId).toBeUndefined()
    expect(specs[0].customDataJson).toBe('{"a":1}')
  })

  it('defaults every optional field to undefined when absent', () => {
    const specs = extractGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'ping-identity',
      entityType: 'groups',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Engineering' } }],
      snapshot: {},
    })
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].populationId).toBeUndefined()
    expect(specs[0].userFilter).toBeUndefined()
    expect(specs[0].externalId).toBeUndefined()
    expect(specs[0].customDataJson).toBeUndefined()
  })
})

describe('parseCustomData', () => {
  it('parses a valid JSON object', () => {
    expect(parseCustomData('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' })
  })
  it('returns null for malformed JSON', () => {
    expect(parseCustomData('{not json')).toBeNull()
  })
  it('returns null for a JSON array', () => {
    expect(parseCustomData('[1,2,3]')).toBeNull()
  })
  it('returns null for a JSON primitive', () => {
    expect(parseCustomData('"just a string"')).toBeNull()
    expect(parseCustomData('42')).toBeNull()
    expect(parseCustomData('true')).toBeNull()
  })
  it('accepts an empty JSON object', () => {
    expect(parseCustomData('{}')).toEqual({})
  })
})

describe('groupKey', () => {
  it('produces the same key for matching name + population', () => {
    expect(groupKey('Engineering', 'pop-1')).toBe(groupKey('Engineering', 'pop-1'))
  })
  it('produces a different key for the same name in a different population', () => {
    expect(groupKey('Engineering', 'pop-1') === groupKey('Engineering', 'pop-2')).toBe(false)
  })
  it('produces a different key for scoped vs. unscoped groups of the same name', () => {
    expect(groupKey('Engineering', 'pop-1') === groupKey('Engineering', undefined)).toBe(false)
  })
  it('treats an unscoped group consistently regardless of undefined vs. omitted population', () => {
    expect(groupKey('Engineering')).toBe(groupKey('Engineering', undefined))
  })
})
