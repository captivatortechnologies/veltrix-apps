import validate, {
  extractProfileSchemaSpecs,
  parseJsonObject,
  baseAttributesFor,
} from '../validate'
import {
  buildCustomUpdateBody,
  schemaLabel,
  schemaPath,
  type ProfileSchemaRollbackEntry,
} from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'profile-schemas',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'profile-schemas',
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
    entityType: 'profile-schemas',
    items: sections,
    sections,
    snapshot: {},
  }
}

const ATTR = JSON.stringify({ badgeId: { title: 'Badge ID', type: 'string' } })

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaType: 'user', userTypeId: 'default', attributesJson: ATTR, ...over }
}

describe('Okta Profile Schemas Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid user schema with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Schema', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates a group schema', async () => {
    const result = await validate(
      makeCtx([{ name: 'Schema', fields: validFields({ schemaType: 'group', userTypeId: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates an attribute removal (name -> null)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Schema', fields: validFields({ attributesJson: '{"legacyId":null}' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid schema type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ schemaType: 'app' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_schema_type')).toBe(true)
  })

  it('rejects missing attributes', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('attributesJson'))).toBe(true)
  })

  it('rejects attributesJson that is not a JSON object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '["a"]' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_attributes')).toBe(true)
  })

  it('rejects an empty attributes object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '{}' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_attributes')).toBe(true)
  })

  it('rejects a custom attribute that collides with an immutable base user attribute', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '{"firstName":{"title":"X","type":"string"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'immutable_base_attribute')).toBe(true)
  })

  it('rejects a base collision case-insensitively', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '{"FirstName":{"title":"X","type":"string"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'immutable_base_attribute')).toBe(true)
  })

  it('rejects the group base attribute "name" on a group schema', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ schemaType: 'group', attributesJson: '{"name":{"title":"X","type":"string"}}' }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'immutable_base_attribute')).toBe(true)
  })

  it('rejects an invalid attribute type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '{"badgeId":{"title":"X","type":"date"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_attribute_type')).toBe(true)
  })

  it('warns when a custom attribute has no title', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ attributesJson: '{"badgeId":{"type":"string"}}' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_attribute_title')).toBe(true)
  })

  it('rejects a duplicate (schemaType, userTypeId) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_schema')).toBe(true)
  })

  it('allows the same schema type across different user types', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ userTypeId: 'default' }) },
        { name: 'sec2', fields: validFields({ userTypeId: 'oty1contractor' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractProfileSchemaSpecs', () => {
  it('normalizes group userTypeId to "default" and defaults a blank user typeId', () => {
    const specs = extractProfileSchemaSpecs(
      makeCanvas([
        { name: 's1', fields: { schemaType: 'group', userTypeId: 'ignored', attributesJson: ATTR } },
        { name: 's2', fields: { schemaType: 'user', userTypeId: '  ', attributesJson: ATTR } },
      ]),
    )
    expect(specs[0].userTypeId).toBe('default')
    expect(specs[1].userTypeId).toBe('default')
    expect(specs[0].attributes).toEqual({ badgeId: { title: 'Badge ID', type: 'string' } })
  })

  it('leaves attributes null when attributesJson is not an object', () => {
    const specs = extractProfileSchemaSpecs(
      makeCanvas([{ name: 's1', fields: { schemaType: 'user', attributesJson: 'not json' } }]),
    )
    expect(specs[0].attributes).toBeNull()
  })
})

describe('parseJsonObject', () => {
  it('returns the object for a JSON object (allowing null values) and null otherwise', () => {
    expect(parseJsonObject('{"a":null}')).toEqual({ a: null })
    expect(parseJsonObject('["a"]')).toBeNull()
    expect(parseJsonObject('42')).toBeNull()
    expect(parseJsonObject('nope')).toBeNull()
  })
})

describe('baseAttributesFor', () => {
  it('returns the immutable base set per schema type', () => {
    expect(baseAttributesFor('user').has('firstname')).toBe(true)
    expect(baseAttributesFor('group').has('name')).toBe(true)
    expect(baseAttributesFor('group').has('firstname')).toBe(false)
    expect(baseAttributesFor('app').size).toBe(0)
  })
})

describe('schemaPath / schemaLabel', () => {
  it('builds the correct REST path per schema type', () => {
    expect(schemaPath('user', 'default')).toBe('/meta/schemas/user/default')
    expect(schemaPath('user', 'oty1contractor')).toBe('/meta/schemas/user/oty1contractor')
    expect(schemaPath('group', 'default')).toBe('/meta/schemas/group/default')
  })

  it('labels a schema for messages', () => {
    expect(schemaLabel('user', 'default')).toBe('user schema "default"')
    expect(schemaLabel('group', 'default')).toBe('the group schema')
  })
})

describe('buildCustomUpdateBody', () => {
  it('wraps the attribute map in a #custom definitions patch', () => {
    const body = buildCustomUpdateBody({ badgeId: { title: 'Badge ID', type: 'string' }, legacyId: null })
    expect(body).toEqual({
      definitions: {
        custom: {
          id: '#custom',
          type: 'object',
          properties: { badgeId: { title: 'Badge ID', type: 'string' }, legacyId: null },
        },
      },
    })
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: ProfileSchemaRollbackEntry | null = null
void _rollbackEntryType
