import validate, {
  extractGroupSpecs,
  metadataValuesAreStrings,
  normalizeGroupName,
  normalizeGroupType,
  parseMetadataObject,
  splitList,
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
    configTypeId: 'identity-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
      entityType: 'identity-groups',
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
    entityType: 'identity-groups',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Vault Identity Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal internal group', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { name: 'platform-admins', type: 'internal' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('defaults the type to internal when blank and stays valid', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { name: 'admins' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates an internal group with policies, members and metadata', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Group',
          fields: {
            name: 'sre',
            type: 'internal',
            policies: ['default', 'sre-policy'],
            memberEntityIds: ['ent-1', 'ent-2'],
            memberGroupIds: ['grp-9'],
            metadataJson: '{"team":"sre","env":"prod"}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an external group with no members', async () => {
    const result = await validate(
      makeCtx([{ name: 'Group', fields: { name: 'ldap-admins', type: 'external', policies: ['admin'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'g1', fields: { type: 'internal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'g1', fields: { name: 'bad name!', type: 'internal' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an unknown group type', async () => {
    const result = await validate(makeCtx([{ name: 'g1', fields: { name: 'admins', type: 'hybrid' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an external group that sets member entity IDs', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'ldap-admins', type: 'external', memberEntityIds: ['ent-1'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'external_members_not_allowed')).toBe(true)
  })

  it('rejects an external group that sets member group IDs', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'ldap-admins', type: 'external', memberGroupIds: ['grp-1'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'external_members_not_allowed')).toBe(true)
  })

  it('allows an internal group that sets members', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'sre', type: 'internal', memberEntityIds: ['ent-1'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects metadata that is not a JSON object', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'admins', type: 'internal', metadataJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects metadata given as a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'admins', type: 'internal', metadataJson: '["a","b"]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects metadata with non-string values', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'admins', type: 'internal', metadataJson: '{"count":3}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata_value')).toBe(true)
  })

  it('accepts a metadata object of string values', async () => {
    const result = await validate(
      makeCtx([{ name: 'g1', fields: { name: 'admins', type: 'internal', metadataJson: '{"team":"platform"}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate group name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'g1', fields: { name: 'admins', type: 'internal' } },
        { name: 'g2', fields: { name: 'admins', type: 'external' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows two distinct group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'g1', fields: { name: 'admins', type: 'internal' } },
        { name: 'g2', fields: { name: 'readers', type: 'external' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractGroupSpecs', () => {
  it('trims the name, defaults + lower-cases the type, splits tag lists and drops blank metadata', () => {
    const specs = extractGroupSpecs(
      makeCanvas([
        {
          name: 'g1',
          fields: {
            name: '  sre  ',
            type: '  Internal  ',
            policies: ['default', 'default', 'sre'],
            memberEntityIds: 'ent-1, ent-2',
            memberGroupIds: '',
            metadataJson: '   ',
          },
        },
      ]),
    )
    expect(specs[0].name).toBe('sre')
    expect(specs[0].type).toBe('internal')
    // policies are de-duped
    expect(specs[0].policies).toEqual(['default', 'sre'])
    // a comma-separated string splits into a list
    expect(specs[0].memberEntityIds).toEqual(['ent-1', 'ent-2'])
    expect(specs[0].memberGroupIds).toHaveLength(0)
    expect(specs[0].metadataJson).toBeUndefined()
  })
})

describe('normalizeGroupType', () => {
  it('defaults to internal and folds case', () => {
    expect(normalizeGroupType('')).toBe('internal')
    expect(normalizeGroupType(undefined)).toBe('internal')
    expect(normalizeGroupType('EXTERNAL')).toBe('external')
  })
})

describe('normalizeGroupName', () => {
  it('trims strings and returns empty for non-strings', () => {
    expect(normalizeGroupName('  admins  ')).toBe('admins')
    expect(normalizeGroupName(42)).toBe('')
  })
})

describe('splitList', () => {
  it('accepts arrays and comma/newline strings, trims, drops blanks and de-dupes', () => {
    expect(splitList(['a', ' b ', 'a', ''])).toEqual(['a', 'b'])
    expect(splitList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toEqual([])
  })
})

describe('parseMetadataObject', () => {
  it('returns the object for a JSON object and null otherwise', () => {
    expect(parseMetadataObject('{"a":"b"}')).toEqual({ a: 'b' })
    expect(parseMetadataObject('[]')).toBeNull()
    expect(parseMetadataObject('"x"')).toBeNull()
    expect(parseMetadataObject('nope')).toBeNull()
  })
})

describe('metadataValuesAreStrings', () => {
  it('is true only when every value is a string', () => {
    expect(metadataValuesAreStrings({ a: 'b', c: 'd' })).toBe(true)
    expect(metadataValuesAreStrings({})).toBe(true)
    expect(metadataValuesAreStrings({ a: 1 })).toBe(false)
  })
})
