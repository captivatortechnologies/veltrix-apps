import validate, {
  coerceBoolean,
  extractEntitySpecs,
  normalizeList,
  normalizeMetadata,
  parseMetadataObject,
  resolveMetadata,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'identity-entities',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'identity-entities',
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
    toolType: 'hashicorp-vault',
    entityType: 'identity-entities',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Identity Entities Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal entity (name only)', async () => {
    const result = await validate(makeCtx([{ name: 'Entity', fields: { name: 'svc-deployer' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a full entity with policies, metadata and disabled', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Entity',
          fields: {
            name: 'svc-deployer',
            disabled: true,
            policies: ['deploy', 'read-secrets'],
            metadataJson: '{"team":"platform","tier":"gold"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policies: ['deploy'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad name/here' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('accepts a name with allowed special characters', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'svc.deployer_1@corp-x' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate entity name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'svc-deployer' } },
        { name: 'sec2', fields: { name: 'svc-deployer' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_entity')).toBe(true)
  })

  it('allows two distinct entity names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'svc-a' } },
        { name: 'sec2', fields: { name: 'svc-b' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a policy name containing whitespace', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'svc', policies: ['read secrets'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_policy')).toBe(true)
  })

  it('rejects metadata that is not a JSON object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'svc', metadataJson: '["a","b"]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects invalid JSON metadata', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'svc', metadataJson: '{not json}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects a non-string metadata value', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'svc', metadataJson: '{"tier":1}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata_value')).toBe(true)
  })
})

describe('extractEntitySpecs', () => {
  it('trims the name, defaults disabled to false, normalizes policies, drops blank metadata', () => {
    const specs = extractEntitySpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: '  svc-deployer  ',
            policies: ['deploy', '  read  ', ''],
            metadataJson: '   ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('svc-deployer')
    expect(specs[0].disabled).toBe(false)
    expect(specs[0].policies).toEqual(['deploy', 'read'])
    expect(specs[0].metadataJson).toBeUndefined()
  })

  it('coerces a string disabled flag from a checkbox', () => {
    const specs = extractEntitySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'svc', disabled: 'true' } }]))
    expect(specs[0].disabled).toBe(true)
  })
})

describe('coerceBoolean', () => {
  it('falls back when unset and honours explicit values', () => {
    expect(coerceBoolean(undefined, false)).toBe(false)
    expect(coerceBoolean('', true)).toBe(true)
    expect(coerceBoolean(true, false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean('0', true)).toBe(false)
    expect(coerceBoolean('yes', false)).toBe(true)
  })
})

describe('normalizeList', () => {
  it('normalizes arrays and comma/newline strings, dropping blanks', () => {
    expect(normalizeList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(normalizeList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(normalizeList(undefined)).toEqual([])
  })
})

describe('parseMetadataObject', () => {
  it('accepts a JSON object and rejects arrays / primitives / bad JSON', () => {
    expect(parseMetadataObject('{"a":"b"}')).toEqual({ a: 'b' })
    expect(parseMetadataObject('["a"]')).toBeNull()
    expect(parseMetadataObject('"a"')).toBeNull()
    expect(parseMetadataObject('{bad}')).toBeNull()
  })
})

describe('resolveMetadata', () => {
  it('parses authored metadata, stringifies values, and returns {} for blank', () => {
    expect(resolveMetadata('{"team":"platform","tier":"gold"}')).toEqual({ team: 'platform', tier: 'gold' })
    expect(resolveMetadata(undefined)).toEqual({})
    expect(resolveMetadata('not json')).toEqual({})
  })
})

describe('normalizeMetadata', () => {
  it('coerces a live metadata object to string values and ignores null/arrays', () => {
    expect(normalizeMetadata({ a: 'x', b: 2, c: null })).toEqual({ a: 'x', b: '2' })
    expect(normalizeMetadata(null)).toEqual({})
    expect(normalizeMetadata(['a'])).toEqual({})
  })
})
