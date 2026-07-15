import validate, {
  buildRecastFilter,
  extractRecastRuleSpecs,
  parseFilterObject,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'recast-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'recast-rules',
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

/** A minimal valid RECAST rule's fields. */
function recastFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Downgrade OpenSSL',
    resource_type: 'HOST',
    action: 'RECAST',
    severity: 'low',
    plugin_id: '19506',
    ...overrides,
  }
}

/** A minimal valid ACCEPT rule's fields (no severity). */
function acceptFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Accept SSH warning',
    resource_type: 'HOST',
    action: 'ACCEPT',
    plugin_id: '10881',
    ...overrides,
  }
}

const VALID_FILTER_JSON = '{"severity":["high","critical"]}'

describe('Tenable Recast Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid RECAST rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: recastFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid ACCEPT rule with no severity', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: acceptFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a rule with host_targets, filter_json and expires_at', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: recastFields({
            host_targets: '10.0.0.0/8',
            filter_json: VALID_FILTER_JSON,
            expires_at: '2026-12-31T23:59:59Z',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: recastFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing resource_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ resource_type: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('resource_type'))).toBe(true)
  })

  it('rejects an invalid resource_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ resource_type: 'ROUTER' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_resource_type')).toBe(true)
  })

  it('rejects a missing action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: recastFields({ action: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('action'))).toBe(true)
  })

  it('rejects an invalid action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: recastFields({ action: 'MUTE' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects a RECAST rule missing severity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ severity: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('severity'))).toBe(true)
  })

  it('rejects an invalid severity value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ severity: 'urgent' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects an ACCEPT rule that carries a severity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: acceptFields({ severity: 'low' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'severity_not_allowed')).toBe(true)
  })

  it('rejects a missing plugin_id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ plugin_id: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('plugin_id'))).toBe(true)
  })

  it('rejects a non-numeric plugin_id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ plugin_id: 'CVE-2021-0001' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_plugin_id')).toBe(true)
  })

  it('rejects a malformed filter_json', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ filter_json: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filter_json')).toBe(true)
  })

  it('rejects a filter_json that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ filter_json: '[1,2,3]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filter_json')).toBe(true)
  })

  it('rejects an invalid expires_at', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ expires_at: '2026-12-31' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_expires_at')).toBe(true)
  })

  it('rejects a duplicate rule name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: recastFields({ name: 'Dup', plugin_id: '19506' }) },
        { name: 'sec2', fields: recastFields({ name: 'Dup', plugin_id: '10881' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a duplicate (resource_type, plugin_id, action) tuple', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: recastFields({ name: 'A' }) },
        { name: 'sec2', fields: recastFields({ name: 'B' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('allows the same plugin_id under a different action', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: recastFields({ name: 'A', plugin_id: '19506' }) },
        { name: 'sec2', fields: acceptFields({ name: 'B', plugin_id: '19506' }) },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractRecastRuleSpecs', () => {
  it('trims fields, upper-cases the enums, lower-cases severity and drops empty optionals', () => {
    const specs = extractRecastRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'recast-rules',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  My Rule  ',
            resource_type: '  host  ',
            action: '  recast  ',
            severity: '  LOW  ',
            plugin_id: '  19506  ',
            host_targets: '  ',
            filter_json: '',
            expires_at: '  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('My Rule')
    expect(specs[0].resourceType).toBe('HOST')
    expect(specs[0].action).toBe('RECAST')
    expect(specs[0].severity).toBe('low')
    expect(specs[0].pluginId).toBe('19506')
    expect(specs[0].hostTargets).toBeUndefined()
    expect(specs[0].filterJson).toBeUndefined()
    expect(specs[0].expiresAt).toBeUndefined()
  })

  it('coerces a numeric plugin_id to a string', () => {
    const specs = extractRecastRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'recast-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'R', plugin_id: 19506 } }],
      snapshot: {},
    })
    expect(specs[0].pluginId).toBe('19506')
  })
})

describe('buildRecastFilter', () => {
  it('builds a filter with just plugin_id', () => {
    expect(
      buildRecastFilter({ sectionName: 's', name: 'R', resourceType: 'HOST', action: 'RECAST', pluginId: '19506' }),
    ).toEqual({ plugin_id: '19506' })
  })

  it('adds host_targets and merges a filter_json object', () => {
    const filter = buildRecastFilter({
      sectionName: 's',
      name: 'R',
      resourceType: 'HOST',
      action: 'RECAST',
      pluginId: '19506',
      hostTargets: '10.0.0.0/8',
      filterJson: '{"severity":["high"]}',
    })
    expect(filter).toEqual({ plugin_id: '19506', host_targets: '10.0.0.0/8', severity: ['high'] })
  })

  it('ignores an invalid filter_json (validate rejects it separately)', () => {
    const filter = buildRecastFilter({
      sectionName: 's',
      name: 'R',
      resourceType: 'HOST',
      action: 'RECAST',
      pluginId: '19506',
      filterJson: '{bad',
    })
    expect(filter).toEqual({ plugin_id: '19506' })
  })
})

describe('parseFilterObject', () => {
  it('parses a JSON object', () => {
    expect(parseFilterObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseFilterObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseFilterObject('{nope')).toBe(null)
  })
})
