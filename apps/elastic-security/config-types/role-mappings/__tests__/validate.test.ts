import validate, {
  extractMappingSpecs,
  parseJsonObject,
  splitList,
  toBool,
} from '../validate'
import { sameSet, stripUnderscoreKeys } from '../driftDetect'
import { buildMappingBody, isReservedMapping } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'role-mappings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'role-mappings',
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

const VALID_RULES = '{"all":[{"field":{"realm.name":"saml1"}},{"field":{"groups":"admins"}}]}'

function validMappingFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'sso-admins', enabled: true, roles: ['superuser'], rulesJson: VALID_RULES, ...overrides }
}

describe('Elastic Role Mappings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid mapping', async () => {
    const result = await validate(makeCtx([{ name: 'Mapping', fields: validMappingFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validMappingFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an empty roles list', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validMappingFields({ roles: [] }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('roles'))).toBe(true)
  })

  it('rejects a missing rulesJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validMappingFields({ rulesJson: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rulesJson'))).toBe(true)
  })

  it('rejects malformed rules JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validMappingFields({ rulesJson: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects a rules value that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validMappingFields({ rulesJson: '[1,2,3]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('warns (but does not fail) when rules has no recognised top-level operator', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validMappingFields({ rulesJson: '{"unknown":true}' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unrecognized_rules')).toBe(true)
  })

  it('accepts optional metadata and warns on reserved (underscore) keys', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validMappingFields({ metadataJson: '{"team":"secops","_reserved":true}' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'reserved_metadata')).toBe(true)
  })

  it('rejects malformed metadata JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validMappingFields({ metadataJson: '{nope' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_metadata')).toBe(true)
  })

  it('rejects a duplicate mapping name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validMappingFields({ name: 'sso-admins' }) },
        { name: 'sec2', fields: validMappingFields({ name: 'sso-admins' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_mapping')).toBe(true)
  })

  it('allows two distinct mapping names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validMappingFields({ name: 'sso-admins' }) },
        { name: 'sec2', fields: validMappingFields({ name: 'sso-viewers', roles: ['viewer'] }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractMappingSpecs', () => {
  it('trims fields, coerces enabled, splits roles and drops blank JSON', () => {
    const specs = extractMappingSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'role-mappings',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  sso-admins  ',
            enabled: 'false',
            roles: 'superuser, kibana_admin',
            rulesJson: '   ',
            metadataJson: '',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('sso-admins')
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].roles).toEqual(['superuser', 'kibana_admin'])
    expect(specs[0].rulesJson).toBeUndefined()
    expect(specs[0].metadataJson).toBeUndefined()
  })

  it('defaults enabled to true when unset', () => {
    const specs = extractMappingSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'role-mappings',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'm', roles: ['r'], rulesJson: VALID_RULES } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(true)
  })
})

describe('parseJsonObject', () => {
  it('parses a JSON object', () => {
    expect(parseJsonObject('{"field":{"username":"*"}}')).toEqual({ field: { username: '*' } })
  })
  it('rejects a JSON array', () => {
    expect(parseJsonObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseJsonObject('{nope')).toBe(null)
  })
})

describe('toBool', () => {
  it('coerces string and falls back on empty', () => {
    expect(toBool('false', true)).toBe(false)
    expect(toBool('true', false)).toBe(true)
    expect(toBool('', true)).toBe(true)
    expect(toBool(undefined, true)).toBe(true)
  })
})

describe('splitList', () => {
  it('accepts an array and a delimited string', () => {
    expect(splitList(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(undefined)).toEqual([])
  })
})

describe('buildMappingBody', () => {
  it('builds the upsert body with enabled, roles and parsed rules', () => {
    const body = buildMappingBody({
      sectionName: 's',
      name: 'sso-admins',
      enabled: true,
      roles: ['superuser'],
      rulesJson: '{"field":{"username":"*"}}',
    })
    expect(body).toEqual({ enabled: true, roles: ['superuser'], rules: { field: { username: '*' } } })
  })

  it('includes metadata when present', () => {
    const body = buildMappingBody({
      sectionName: 's',
      name: 'sso-admins',
      enabled: false,
      roles: ['viewer'],
      rulesJson: '{"all":[]}',
      metadataJson: '{"team":"secops"}',
    })
    expect(body.metadata).toEqual({ team: 'secops' })
    expect(body.enabled).toBe(false)
  })

  it('throws on malformed rules', () => {
    let threw = false
    try {
      buildMappingBody({ sectionName: 's', name: 'm', enabled: true, roles: ['r'], rulesJson: '[1,2]' })
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

describe('isReservedMapping', () => {
  it('flags a mapping with metadata._reserved true', () => {
    expect(isReservedMapping({ metadata: { _reserved: true } })).toBe(true)
  })
  it('does not flag a mapping without the reserved flag', () => {
    expect(isReservedMapping({ metadata: { _reserved: false } })).toBe(false)
    expect(isReservedMapping({ metadata: { team: 'secops' } })).toBe(false)
    expect(isReservedMapping({})).toBe(false)
  })
})

describe('sameSet (drift comparison)', () => {
  it('is order-insensitive', () => {
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true)
  })
  it('detects a changed set', () => {
    expect(sameSet(['a'], ['a', 'b'])).toBe(false)
    expect(sameSet(['a'], ['b'])).toBe(false)
  })
})

describe('stripUnderscoreKeys (metadata drift)', () => {
  it('removes reserved underscore keys but keeps author keys', () => {
    expect(stripUnderscoreKeys({ team: 'secops', _reserved: true })).toEqual({ team: 'secops' })
  })
  it('handles undefined', () => {
    expect(stripUnderscoreKeys(undefined)).toEqual({})
  })
})
