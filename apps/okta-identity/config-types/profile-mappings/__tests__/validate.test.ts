import validate, {
  extractMappingSpecs,
  parseConfigObject,
  PUSH_STATUSES,
} from '../validate'
import {
  buildMappingUpdateBody,
  mappingLabel,
  mappingPath,
  type ProfileMappingRollbackEntry,
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
    configTypeId: 'profile-mappings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'profile-mappings',
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
    entityType: 'profile-mappings',
    items: sections,
    sections,
    snapshot: {},
  }
}

const PROPS = JSON.stringify({ firstName: { expression: 'user.firstName', pushStatus: 'PUSH' } })

function validFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: 'oty1source', targetId: '0oa1target', propertiesJson: PROPS, ...over }
}

describe('Okta Profile Mappings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully valid mapping with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'Mapping', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates a DONT_PUSH property', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Mapping',
          fields: validFields({
            propertiesJson: '{"displayName":{"expression":"user.firstName","pushStatus":"DONT_PUSH"}}',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a property removal (expression and pushStatus both null)', async () => {
    const result = await validate(
      makeCtx([{ name: 'Mapping', fields: validFields({ propertiesJson: '{"legacyId":{"expression":null,"pushStatus":null}}' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing sourceId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ sourceId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('sourceId'))).toBe(true)
  })

  it('rejects a missing targetId', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ targetId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('targetId'))).toBe(true)
  })

  it('rejects missing propertiesJson', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('propertiesJson'))).toBe(true)
  })

  it('rejects propertiesJson that is not a JSON object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '["a"]' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_properties')).toBe(true)
  })

  it('rejects an empty properties object', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '{}' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_properties')).toBe(true)
  })

  it('rejects a property value that is not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '{"firstName":"user.firstName"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_property')).toBe(true)
  })

  it('rejects a property with a non-empty expression but an invalid pushStatus', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '{"firstName":{"expression":"user.firstName","pushStatus":"MAYBE"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_property')).toBe(true)
  })

  it('rejects a property with a string expression but a missing pushStatus', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '{"firstName":{"expression":"user.firstName"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_property')).toBe(true)
  })

  it('rejects a half-removal (expression null but pushStatus set)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ propertiesJson: '{"firstName":{"expression":null,"pushStatus":"PUSH"}}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_property')).toBe(true)
  })

  it('rejects a duplicate (sourceId, targetId) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_pair')).toBe(true)
  })

  it('allows the same source across different targets', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ targetId: '0oa1target' }) },
        { name: 'sec2', fields: validFields({ targetId: '0oa2other' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractMappingSpecs', () => {
  it('trims ids and leaves a blank propertiesJson undefined', () => {
    const specs = extractMappingSpecs(
      makeCanvas([{ name: 's1', fields: { sourceId: '  oty1  ', targetId: '  0oa2  ', propertiesJson: '   ' } }]),
    )
    expect(specs[0].sourceId).toBe('oty1')
    expect(specs[0].targetId).toBe('0oa2')
    expect(specs[0].propertiesJson).toBeUndefined()
  })

  it('preserves the raw propertiesJson string', () => {
    const specs = extractMappingSpecs(makeCanvas([{ name: 's1', fields: { sourceId: 'a', targetId: 'b', propertiesJson: PROPS } }]))
    expect(specs[0].propertiesJson).toBe(PROPS)
  })
})

describe('parseConfigObject', () => {
  it('returns the object for a JSON object (allowing null values) and null otherwise', () => {
    expect(parseConfigObject('{"a":{"expression":null,"pushStatus":null}}')).toEqual({
      a: { expression: null, pushStatus: null },
    })
    expect(parseConfigObject('["a"]')).toBeNull()
    expect(parseConfigObject('42')).toBeNull()
    expect(parseConfigObject('nope')).toBeNull()
  })
})

describe('PUSH_STATUSES', () => {
  it('is exactly PUSH and DONT_PUSH', () => {
    expect(PUSH_STATUSES).toEqual(['PUSH', 'DONT_PUSH'])
  })
})

describe('mappingPath / mappingLabel', () => {
  it('builds the REST path for a mapping id (URL-encoded)', () => {
    expect(mappingPath('map123')).toBe('/mappings/map123')
    expect(mappingPath('map/1 2')).toBe('/mappings/map%2F1%202')
  })

  it('labels a mapping for messages', () => {
    expect(mappingLabel('oty1', '0oa2')).toBe('source "oty1" -> target "0oa2"')
  })
})

describe('buildMappingUpdateBody', () => {
  it('wraps the property map in a properties patch', () => {
    const body = buildMappingUpdateBody({
      firstName: { expression: 'user.firstName', pushStatus: 'PUSH' },
      legacyId: { expression: null, pushStatus: null },
    })
    expect(body).toEqual({
      properties: {
        firstName: { expression: 'user.firstName', pushStatus: 'PUSH' },
        legacyId: { expression: null, pushStatus: null },
      },
    })
  })
})

// Type-only reference so the rollback entry shape stays in sync with deploy.
const _rollbackEntryType: ProfileMappingRollbackEntry | null = null
void _rollbackEntryType
