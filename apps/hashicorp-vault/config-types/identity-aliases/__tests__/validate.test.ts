import validate, {
  extractIdentityAliasSpecs,
  aliasKey,
  parseMetadataObject,
  resolveMetadata,
} from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_UUID = '11111111-2222-3333-4444-555555555555'
const VALID_ACCESSOR = 'auth_userpass_1a2b3c4d'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'identity-aliases',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'identity-aliases',
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
    entityType: 'identity-aliases',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Identity Aliases Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid entity alias', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Alias',
          fields: { kind: 'entity', name: 'jdoe@example.com', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid group alias', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Alias',
          fields: { kind: 'group', name: 'platform-admins', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing kind', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('kind'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { kind: 'entity', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing canonicalId', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { kind: 'entity', name: 'x', mountAccessor: VALID_ACCESSOR } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('canonicalId'))).toBe(true)
  })

  it('rejects a missing mountAccessor', async () => {
    const result = await validate(makeCtx([{ name: 'a1', fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('mountAccessor'))).toBe(true)
  })

  it('warns (but stays valid) on a non-UUID canonicalId', async () => {
    const result = await validate(
      makeCtx([{ name: 'a1', fields: { kind: 'entity', name: 'x', canonicalId: 'not-a-uuid', mountAccessor: VALID_ACCESSOR } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_canonical_id')).toBe(true)
  })

  it('warns (but stays valid) on an unusual mountAccessor', async () => {
    const result = await validate(
      makeCtx([{ name: 'a1', fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID, mountAccessor: 'not-an-accessor' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'suspicious_accessor')).toBe(true)
  })

  it('rejects a duplicate (kind, mountAccessor, name)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a1', fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } },
        { name: 'a2', fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_alias')).toBe(true)
  })

  it('allows the same name across different kinds or accessors', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a1', fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } },
        { name: 'a2', fields: { kind: 'group', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts custom metadata on an entity alias', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a1',
          fields: {
            kind: 'entity',
            name: 'x',
            canonicalId: VALID_UUID,
            mountAccessor: VALID_ACCESSOR,
            customMetadataJson: '{"source":"okta"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects malformed custom metadata on an entity alias', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a1',
          fields: { kind: 'entity', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR, customMetadataJson: 'not json' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('warns (but stays valid) that metadata is ignored on a group alias', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'a1',
          fields: { kind: 'group', name: 'x', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR, customMetadataJson: '{"a":"b"}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'metadata_ignored')).toBe(true)
  })
})

describe('extractIdentityAliasSpecs', () => {
  it('trims fields and normalizes kind', () => {
    const specs = extractIdentityAliasSpecs(
      makeCanvas([{ name: 'a1', fields: { kind: '  ENTITY  ', name: '  jdoe  ', canonicalId: VALID_UUID, mountAccessor: VALID_ACCESSOR } }]),
    )
    expect(specs[0].kind).toBe('entity')
    expect(specs[0].name).toBe('jdoe')
  })

  it('yields an empty kind for an unrecognized value', () => {
    const specs = extractIdentityAliasSpecs(makeCanvas([{ name: 'a1', fields: { kind: 'nonsense', name: 'x' } }]))
    expect(specs[0].kind).toBe('')
  })
})

describe('aliasKey', () => {
  it('joins kind, mountAccessor and name', () => {
    expect(aliasKey('entity', VALID_ACCESSOR, 'jdoe')).toBe(`entity/${VALID_ACCESSOR}/jdoe`)
  })
})

describe('parseMetadataObject / resolveMetadata', () => {
  it('parses a valid object and rejects arrays/primitives', () => {
    expect(parseMetadataObject('{"a":"b"}')).toEqual({ a: 'b' })
    expect(parseMetadataObject('[1,2]')).toBeNull()
    expect(parseMetadataObject('not json')).toBeNull()
  })

  it('resolves to a string map, stringifying non-string values', () => {
    expect(resolveMetadata('{"a":"b","n":1}')).toEqual({ a: 'b', n: '1' })
    expect(resolveMetadata(undefined)).toEqual({})
  })
})
