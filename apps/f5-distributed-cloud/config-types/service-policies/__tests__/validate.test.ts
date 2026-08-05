import validate, { extractServicePolicySpecs, parseRuleList } from '../validate'
import { buildServicePolicySpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_RULE_LIST_JSON = JSON.stringify([
  { metadata: { name: 'allow-admins' }, spec: { action: 'ALLOW', path: { prefix_values: ['/admin'] } } },
])

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'service-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'service-policies',
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
    toolType: 'f5-distributed-cloud',
    entityType: 'service-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC Service Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal allow_list policy', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'allow-corp-vpn' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates an allow_all_requests policy', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'allow-all', mode: 'allow_all_requests' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a rule_list policy with valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'custom-rules', mode: 'rule_list', ruleListJson: VALID_RULE_LIST_JSON } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a rule_list policy with invalid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'custom-rules', mode: 'rule_list', ruleListJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a rule_list policy with a bad action value', async () => {
    const badJson = JSON.stringify([{ metadata: { name: 'r1' }, spec: { action: 'MAYBE' } }])
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'custom-rules', mode: 'rule_list', ruleListJson: badJson } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'allow-corp-vpn' } },
        { name: 'sec2', fields: { name: 'allow-corp-vpn' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires serverName when serverScope is server_name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'scoped-policy', serverScope: 'server_name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('serverName'))).toBe(true)
  })
})

describe('parseRuleList', () => {
  it('parses a valid rule list', () => {
    expect(parseRuleList(VALID_RULE_LIST_JSON)).toHaveLength(1)
  })

  it('returns null for an empty array', () => {
    expect(parseRuleList('[]')).toBeNull()
  })

  it('returns null when action is not ALLOW/DENY', () => {
    expect(parseRuleList(JSON.stringify([{ metadata: { name: 'r1' }, spec: { action: 'MAYBE' } }]))).toBeNull()
  })
})

describe('extractServicePolicySpecs', () => {
  it('defaults algo, serverScope and mode', () => {
    const specs = extractServicePolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1' } }]))
    expect(specs[0].algo).toBe('FIRST_MATCH')
    expect(specs[0].serverScope).toBe('any_server')
    expect(specs[0].mode).toBe('allow_list')
  })

  it('uppercases country codes', () => {
    const specs = extractServicePolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1', listCountries: ['us', 'ca'] } }]))
    expect(specs[0].listCountries).toEqual(['US', 'CA'])
  })
})

describe('buildServicePolicySpecBody', () => {
  it('builds an allow_list body with prefixes/countries/default action', () => {
    const specs = extractServicePolicySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'p1', listPrefixes: ['10.0.0.0/8'], listCountries: ['US'] } }]),
    )
    const body = buildServicePolicySpecBody(specs[0])
    expect(body?.algo).toBe('FIRST_MATCH')
    expect(body?.any_server).toBe(true)
    expect(body?.allow_list).toEqual({
      prefix_list: { prefixes: ['10.0.0.0/8'] },
      country_list: ['US'],
      default_action_next_policy: true,
    })
  })

  it('builds a server_name-scoped body', () => {
    const specs = extractServicePolicySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'p1', serverScope: 'server_name', serverName: 'api.example.com' } }]),
    )
    const body = buildServicePolicySpecBody(specs[0])
    expect(body?.server_name).toBe('api.example.com')
    expect(body?.any_server).toBeUndefined()
  })

  it('builds a rule_list body', () => {
    const specs = extractServicePolicySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'p1', mode: 'rule_list', ruleListJson: VALID_RULE_LIST_JSON } }]),
    )
    const body = buildServicePolicySpecBody(specs[0])
    expect(body?.rule_list?.rules).toHaveLength(1)
  })

  it('returns null for an invalid rule_list', () => {
    const specs = extractServicePolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1', mode: 'rule_list', ruleListJson: 'bad' } }]))
    expect(buildServicePolicySpecBody(specs[0])).toBeNull()
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'p1', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'p1', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
