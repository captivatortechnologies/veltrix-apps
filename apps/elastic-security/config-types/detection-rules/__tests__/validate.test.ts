import validate, {
  extractRuleSpecs,
  parseRuleObject,
  isPrebuiltRule,
  stripServerFields,
  type RuleSpec,
} from '../validate'
import { buildRuleBody } from '../deploy'
import { deepSubsetEqual } from '../driftDetect'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'detection-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'detection-rules',
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

const VALID_RULE_JSON =
  '{"type":"query","language":"kuery","query":"event.code:4688","index":["logs-*"],"risk_score":47,"severity":"medium","description":"Suspicious process creation"}'

describe('Elastic Detection Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid query rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'Rule', fields: { rule_id: 'com.acme.proc', name: 'Proc rule', ruleJson: VALID_RULE_JSON } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing rule_id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Proc rule', ruleJson: VALID_RULE_JSON } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('rule_id'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'com.acme.proc', ruleJson: VALID_RULE_JSON } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing ruleJson', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'com.acme.proc', name: 'Proc rule' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ruleJson'))).toBe(true)
  })

  it('rejects a rule_id longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'x'.repeat(256), name: 'Proc rule', ruleJson: VALID_RULE_JSON } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length' && e.field.includes('rule_id'))).toBe(true)
  })

  it('rejects a Definition that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'r1', name: 'r', ruleJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('rejects a Definition that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'r1', name: 'r', ruleJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rule_json')).toBe(true)
  })

  it('rejects authoring a legacy prebuilt rule (immutable: true)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { rule_id: 'r1', name: 'r', ruleJson: '{"type":"query","query":"*","immutable":true}' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_rule')).toBe(true)
  })

  it('rejects authoring a prebuilt rule (rule_source.type=external)', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            rule_id: 'r1',
            name: 'r',
            ruleJson: '{"type":"query","query":"*","rule_source":{"type":"external"}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_rule')).toBe(true)
  })

  it('rejects a duplicate rule_id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { rule_id: 'dup', name: 'A', ruleJson: VALID_RULE_JSON } },
        { name: 'sec2', fields: { rule_id: 'dup', name: 'B', ruleJson: VALID_RULE_JSON } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_rule')).toBe(true)
  })

  it('allows distinct rule_ids', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { rule_id: 'a', name: 'A', ruleJson: VALID_RULE_JSON } },
        { name: 'sec2', fields: { rule_id: 'b', name: 'B', ruleJson: VALID_RULE_JSON } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns (does not error) when a rule type is missing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'r1', name: 'r', ruleJson: '{"query":"*"}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_type')).toBe(true)
  })

  it('warns when a query-shaped type has no query field', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { rule_id: 'r1', name: 'r', ruleJson: '{"type":"eql"}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_query')).toBe(true)
  })

  it('warns when a version is set (create-only, stays 1)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { rule_id: 'r1', name: 'r', ruleJson: '{"type":"query","query":"*","version":7}' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'version_ignored')).toBe(true)
  })
})

describe('extractRuleSpecs', () => {
  it('trims fields, defaults enabled to true, and drops an empty ruleJson', () => {
    const specs = extractRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'detection-rules',
      items: [],
      sections: [
        { name: 'sec1', fields: { rule_id: '  r1  ', name: '  My Rule  ', ruleJson: '' } },
      ],
      snapshot: {},
    })
    expect(specs[0].ruleId).toBe('r1')
    expect(specs[0].name).toBe('My Rule')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].ruleJson).toBeUndefined()
  })

  it('honours an explicit enabled=false checkbox', () => {
    const specs = extractRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'detection-rules',
      items: [],
      sections: [{ name: 'sec1', fields: { rule_id: 'r1', name: 'r', enabled: false } }],
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(false)
  })
})

describe('parseRuleObject', () => {
  it('parses a JSON object', () => {
    expect(parseRuleObject('{"type":"query"}')).toEqual({ type: 'query' })
  })
  it('rejects a JSON array', () => {
    expect(parseRuleObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseRuleObject('{nope')).toBe(null)
  })
})

describe('isPrebuiltRule', () => {
  it('detects the legacy immutable marker', () => {
    expect(isPrebuiltRule({ immutable: true })).toBe(true)
  })
  it('detects the external rule_source marker', () => {
    expect(isPrebuiltRule({ rule_source: { type: 'external' } })).toBe(true)
  })
  it('treats an internal rule_source as a custom rule', () => {
    expect(isPrebuiltRule({ rule_source: { type: 'internal' } })).toBe(false)
  })
  it('treats a plain custom rule as not prebuilt', () => {
    expect(isPrebuiltRule({ type: 'query', immutable: false })).toBe(false)
  })
  it('handles null/undefined', () => {
    expect(isPrebuiltRule(null)).toBe(false)
    expect(isPrebuiltRule(undefined)).toBe(false)
  })
})

describe('buildRuleBody', () => {
  const spec: RuleSpec = {
    sectionName: 'sec1',
    ruleId: 'com.acme.proc',
    name: 'Forced Name',
    enabled: false,
    ruleJson: undefined,
  }

  it('forces rule_id / name / enabled over the blob and strips version + server fields', () => {
    const body = buildRuleBody(spec, {
      type: 'query',
      query: 'event.code:4688',
      rule_id: 'IGNORED',
      name: 'IGNORED',
      enabled: true,
      version: 9,
      id: 'obj-1',
      revision: 3,
      created_at: 'x',
      updated_by: 'y',
      execution_summary: { last_execution: {} },
    })
    expect(body.rule_id).toBe('com.acme.proc')
    expect(body.name).toBe('Forced Name')
    expect(body.enabled).toBe(false)
    expect(body.type).toBe('query')
    expect(body.query).toBe('event.code:4688')
    // version and server-managed fields are never sent
    expect(body.version).toBeUndefined()
    expect(body.id).toBeUndefined()
    expect(body.revision).toBeUndefined()
    expect(body.created_at).toBeUndefined()
    expect(body.updated_by).toBeUndefined()
    expect(body.execution_summary).toBeUndefined()
  })
})

describe('stripServerFields', () => {
  it('removes only the server-managed fields', () => {
    const out = stripServerFields({ type: 'query', id: 'x', revision: 1, created_at: 't', keep: 'me' })
    expect(out.id).toBeUndefined()
    expect(out.revision).toBeUndefined()
    expect(out.created_at).toBeUndefined()
    expect(out.type).toBe('query')
    expect(out.keep).toBe('me')
  })
})

describe('deepSubsetEqual (drift subset semantics)', () => {
  it('treats a live superset object as matching the authored subset', () => {
    expect(deepSubsetEqual({ severity: 'medium' }, { severity: 'medium', risk_score: 47, meta: {} })).toBe(true)
  })
  it('flags a changed authored value', () => {
    expect(deepSubsetEqual({ severity: 'medium' }, { severity: 'high' })).toBe(false)
  })
  it('ignores object key order', () => {
    expect(deepSubsetEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })
  it('compares arrays exactly', () => {
    expect(deepSubsetEqual(['logs-*'], ['logs-*'])).toBe(true)
    expect(deepSubsetEqual(['logs-*'], ['logs-*', 'extra-*'])).toBe(false)
  })
  it('reports drift when the authored key is absent from the live rule', () => {
    expect(deepSubsetEqual('kuery', undefined)).toBe(false)
  })
})
