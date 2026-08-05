import validate, {
  extractRecastRuleSpecs,
  isValidRecastFilterShape,
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

const PLUGIN_FILTER = '{"and":[{"property":"definition.id","operator":"eq","value":"19506"}]}'
const OTHER_PLUGIN_FILTER = '{"and":[{"property":"definition.id","operator":"eq","value":"10881"}]}'

/** A minimal valid RECAST rule's fields (Host/Web App family). */
function recastFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Downgrade OpenSSL',
    resource_type: 'HOST',
    action: 'RECAST',
    severity: 'LOW',
    filter_json: PLUGIN_FILTER,
    ...overrides,
  }
}

/** A minimal valid ACCEPT rule's fields (no severity). */
function acceptFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Accept SSH warning',
    resource_type: 'HOST',
    action: 'ACCEPT',
    filter_json: OTHER_PLUGIN_FILTER,
    ...overrides,
  }
}

/** A minimal valid CHANGE_RESULT rule's fields (Host Audit family). */
function changeResultFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Override CIS check',
    resource_type: 'HOST_AUDIT',
    action: 'CHANGE_RESULT',
    compliance_result: 'PASSED',
    filter_json: '{"and":[{"property":"audit_file","operator":"eq","value":"CIS_Level_1.audit"}]}',
    ...overrides,
  }
}

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

  it('validates a valid CHANGE_RESULT (Host Audit) rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: changeResultFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a rule with comment, false_positive, disabled and expires_at', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Rule',
          fields: recastFields({
            comment: 'Vendor confirmed mitigated',
            false_positive: true,
            disabled: true,
            disabled_reason: 'Pending re-scan',
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

  it('rejects RECAST/ACCEPT paired with HOST_AUDIT', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ resource_type: 'HOST_AUDIT' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'incompatible_action')).toBe(true)
  })

  it('rejects CHANGE_RESULT/ACCEPT_RESULT paired with HOST', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: changeResultFields({ resource_type: 'HOST' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'incompatible_action')).toBe(true)
  })

  it('rejects a RECAST rule missing severity', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: recastFields({ severity: '' }) }]))
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
    const result = await validate(makeCtx([{ name: 'sec1', fields: acceptFields({ severity: 'LOW' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'severity_not_allowed')).toBe(true)
  })

  it('rejects a CHANGE_RESULT rule missing compliance_result', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: changeResultFields({ compliance_result: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('compliance_result'))).toBe(
      true,
    )
  })

  it('rejects an invalid compliance_result value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: changeResultFields({ compliance_result: 'MAYBE' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_compliance_result')).toBe(true)
  })

  it('rejects a RECAST rule that carries a compliance_result', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ compliance_result: 'PASSED' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'compliance_result_not_allowed')).toBe(true)
  })

  it('rejects a missing filter', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: recastFields({ filter_json: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('filter_json'))).toBe(true)
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

  it('rejects a filter_json missing both "and" and "or"', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: recastFields({ filter_json: '{"plugin_id":"19506"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filter_json')).toBe(true)
  })

  it('rejects a filter_json with both "and" and "or"', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: recastFields({
            filter_json:
              '{"and":[{"property":"definition.id","operator":"eq","value":"1"}],"or":[{"property":"definition.id","operator":"eq","value":"2"}]}',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filter_json')).toBe(true)
  })

  it('accepts an "or" filter shape', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: recastFields({
            filter_json:
              '{"or":[{"property":"definition.id","operator":"eq","value":"1"},{"property":"definition.id","operator":"eq","value":"2"}]}',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
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
        { name: 'sec1', fields: recastFields({ name: 'Dup' }) },
        { name: 'sec2', fields: acceptFields({ name: 'Dup' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractRecastRuleSpecs', () => {
  it('trims fields, upper-cases the enums, and drops empty optionals', () => {
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
            description: '   ',
            resource_type: '  host  ',
            action: '  recast  ',
            severity: '  low  ',
            compliance_result: '',
            comment: '  ',
            filter_json: `  ${PLUGIN_FILTER}  `,
            expires_at: '  ',
            disabled: false,
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('My Rule')
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].resourceType).toBe('HOST')
    expect(specs[0].action).toBe('RECAST')
    expect(specs[0].severity).toBe('LOW')
    expect(specs[0].complianceResult).toBeUndefined()
    expect(specs[0].comment).toBeUndefined()
    expect(specs[0].filterJson).toBe(PLUGIN_FILTER)
    expect(specs[0].expiresAt).toBeUndefined()
    expect(specs[0].disabled).toBe(false)
  })
})

describe('isValidRecastFilterShape', () => {
  it('accepts a valid "and" shape', () => {
    expect(isValidRecastFilterShape({ and: [{ property: 'definition.id', operator: 'eq', value: '1' }] })).toBe(
      true,
    )
  })
  it('accepts a valid "or" shape', () => {
    expect(isValidRecastFilterShape({ or: [{ property: 'definition.id', operator: 'eq', value: '1' }] })).toBe(
      true,
    )
  })
  it('rejects neither "and" nor "or"', () => {
    expect(isValidRecastFilterShape({ plugin_id: '1' })).toBe(false)
  })
  it('rejects both "and" and "or"', () => {
    expect(
      isValidRecastFilterShape({
        and: [{ property: 'a', operator: 'eq', value: '1' }],
        or: [{ property: 'b', operator: 'eq', value: '2' }],
      }),
    ).toBe(false)
  })
  it('rejects an empty condition array', () => {
    expect(isValidRecastFilterShape({ and: [] })).toBe(false)
  })
  it('rejects a condition missing "property"', () => {
    expect(isValidRecastFilterShape({ and: [{ operator: 'eq', value: '1' }] })).toBe(false)
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
