import validate, {
  extractPbfRuleSpecs,
  buildPbfRuleFields,
  buildPbfAction,
  pbfRuleDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-pbf-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-pbf-rules',
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

describe('Panorama PBF Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal forward rule with an egress interface', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'route-voip', egress_interface: 'ethernet1/2' } }]))
    expect(result.valid).toBe(true)
  })

  it('validates a discard rule with no egress interface required', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action_type: 'discard' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires an egress interface for a forward action', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action_type: 'forward' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.egress_interface'))).toBe(true)
  })

  it('requires a next-hop value when a next-hop type is chosen', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', egress_interface: 'ethernet1/2', nexthop_type: 'ip', nexthop_value: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.nexthop_value'))).toBe(true)
  })

  it('requires the target vsys for a forward_to_vsys action', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action_type: 'forward_to_vsys' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.forward_to_vsys'))).toBe(true)
  })

  it('warns when symmetric return is enabled with no eligible addresses', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', egress_interface: 'eth1', enforce_symmetric_return: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'empty_return_list')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'pbf1', egress_interface: 'eth1' } },
        { name: 'b', fields: { name: 'PBF1', egress_interface: 'eth2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds a forward action with nexthop and monitor', () => {
    const spec = extractPbfRuleSpecs(
      makeCtx([
        {
          name: 'r',
          fields: {
            name: 'x',
            egress_interface: 'ethernet1/2',
            nexthop_type: 'ip',
            nexthop_value: '10.10.0.1',
            monitor_ip: '10.10.0.1',
            monitor_disable_if_unreachable: true,
          },
        },
      ]).canvas,
    )[0]
    expect(buildPbfAction(spec)).toEqual({
      forward: {
        'egress-interface': 'ethernet1/2',
        nexthop: { 'ip-address': '10.10.0.1' },
        monitor: { 'ip-address': '10.10.0.1', 'disable-if-unreachable': 'yes' },
      },
    })
  })

  it('builds discard and forward-to-vsys actions', () => {
    const discardSpec = extractPbfRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'x', action_type: 'discard' } }]).canvas)[0]
    expect(buildPbfAction(discardSpec)).toEqual({ discard: {} })
    const vsysSpec = extractPbfRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', action_type: 'forward_to_vsys', forward_to_vsys: 'vsys2' } }]).canvas,
    )[0]
    expect(buildPbfAction(vsysSpec)).toEqual({ 'forward-to-vsys': 'vsys2' })
  })

  it('builds symmetric-return with an entry-list of addresses', () => {
    const spec = extractPbfRuleSpecs(
      makeCtx([
        { name: 'r', fields: { name: 'x', egress_interface: 'eth1', enforce_symmetric_return: true, symmetric_return_addresses: ['gw-a', 'gw-b'] } },
      ]).canvas,
    )[0]
    const fields = buildPbfRuleFields(spec) as Record<string, unknown>
    expect(fields['enforce-symmetric-return']).toEqual({
      enabled: 'yes',
      'nexthop-address-list': { entry: [{ '@name': 'gw-a' }, { '@name': 'gw-b' }] },
    })
  })

  it('detects action and match drift', () => {
    const spec = extractPbfRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'x', egress_interface: 'eth1' } }]).canvas)[0]
    const clean = pbfRuleDriftDiffs(spec, {
      '@name': 'x',
      from: { zone: { member: ['any'] } },
      source: { member: ['any'] },
      destination: { member: ['any'] },
      application: { member: ['any'] },
      service: { member: ['any'] },
      action: { forward: { 'egress-interface': 'eth1' } },
      'enforce-symmetric-return': { enabled: 'no' },
      disabled: 'no',
    })
    expect(clean).toHaveLength(0)
    const drifted = pbfRuleDriftDiffs(spec, { '@name': 'x', action: { discard: {} } })
    expect(drifted.some((d) => d.field.endsWith('.action'))).toBe(true)
  })
})
