import validate, { extractNetworkPolicySpecs, parseRuleListJson } from '../validate'
import { buildNetworkPolicySpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_INGRESS_JSON = JSON.stringify([
  { metadata: { name: 'allow-https' }, action: 'ALLOW', traffic: { protocol_port_range: { protocol: 'tcp', port_ranges: ['443'] } } },
])

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'network-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'network-policies',
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
    entityType: 'network-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC Network Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal policy (name only, blank rules)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'default-policy' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a policy with valid ingress rules', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'https-policy', ingressRulesJson: VALID_INGRESS_JSON } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects invalid ingress rules JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'p1', ingressRulesJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('ingressRulesJson'))).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'default-policy' } },
        { name: 'sec2', fields: { name: 'default-policy' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires label expressions when endpointMode is label_selector', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'scoped-policy', endpointMode: 'label_selector' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('endpointExpressions'))).toBe(true)
  })
})

describe('parseRuleListJson', () => {
  it('returns an empty array for blank input', () => {
    expect(parseRuleListJson('')).toEqual([])
  })

  it('returns null for invalid JSON', () => {
    expect(parseRuleListJson('nope')).toBeNull()
  })

  it('parses a valid rule array', () => {
    expect(parseRuleListJson(VALID_INGRESS_JSON)).toHaveLength(1)
  })
})

describe('extractNetworkPolicySpecs', () => {
  it('defaults endpointMode to "any"', () => {
    const specs = extractNetworkPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1' } }]))
    expect(specs[0].endpointMode).toBe('any')
  })
})

describe('buildNetworkPolicySpecBody', () => {
  it('builds a body with endpoint: { any: true } and no rules by default', () => {
    const specs = extractNetworkPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1' } }]))
    const body = buildNetworkPolicySpecBody(specs[0])
    expect(body?.endpoint).toEqual({ any: true })
    expect(body?.rules).toBeUndefined()
  })

  it('builds a label_selector endpoint', () => {
    const specs = extractNetworkPolicySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'p1', endpointMode: 'label_selector', endpointExpressions: ['env=prod'] } }]),
    )
    const body = buildNetworkPolicySpecBody(specs[0])
    expect(body?.endpoint).toEqual({ label_selector: { expressions: ['env=prod'] } })
  })

  it('includes ingress_rules when set', () => {
    const specs = extractNetworkPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1', ingressRulesJson: VALID_INGRESS_JSON } }]))
    const body = buildNetworkPolicySpecBody(specs[0])
    expect(body?.rules?.ingress_rules).toHaveLength(1)
    expect(body?.rules?.egress_rules).toBeUndefined()
  })

  it('returns null for invalid rule JSON', () => {
    const specs = extractNetworkPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'p1', egressRulesJson: 'bad' } }]))
    expect(buildNetworkPolicySpecBody(specs[0])).toBeNull()
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'p1', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'p1', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
