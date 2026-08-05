import validate, { extractTcpLoadBalancerSpecs } from '../validate'
import { buildTcpLoadBalancerSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'tcp-load-balancers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'tcp-load-balancers',
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
    entityType: 'tcp-load-balancers',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC TCP Load Balancers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal load balancer', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ssh-lb', listenPort: 22, originPools: ['ssh-pool'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { listenPort: 22, originPools: ['p1'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const fields = { name: 'ssh-lb', listenPort: 22, originPools: ['p1'] }
    const result = await validate(makeCtx([{ name: 'sec1', fields }, { name: 'sec2', fields }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires a listen port when listenPortMode is listen_port', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'ssh-lb', originPools: ['p1'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('listenPort'))).toBe(true)
  })

  it('requires port ranges when listenPortMode is port_ranges', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ssh-lb', listenPortMode: 'port_ranges', originPools: ['p1'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('portRanges'))).toBe(true)
  })

  it('requires at least one origin pool', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'ssh-lb', listenPort: 22 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('originPools'))).toBe(true)
  })

  it('requires attached service policies when servicePoliciesMode is active_service_policies', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'ssh-lb', listenPort: 22, originPools: ['p1'], servicePoliciesMode: 'active_service_policies' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('activeServicePolicies'))).toBe(true)
  })

  it('requires an SNI value when sniMode is sni', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'ssh-lb', listenPort: 22, originPools: ['p1'], sniMode: 'sni' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('sniValue'))).toBe(true)
  })
})

describe('extractTcpLoadBalancerSpecs', () => {
  it('defaults listenPortMode/advertiseMode/tlsMode/loadBalancingAlgorithm/servicePoliciesMode/sniMode', () => {
    const specs = extractTcpLoadBalancerSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'lb1' } }]))
    expect(specs[0].listenPortMode).toBe('listen_port')
    expect(specs[0].advertiseMode).toBe('do_not_advertise')
    expect(specs[0].tlsMode).toBe('tcp')
    expect(specs[0].loadBalancingAlgorithm).toBe('round_robin')
    expect(specs[0].servicePoliciesMode).toBe('no_service_policies')
    expect(specs[0].sniMode).toBe('no_sni')
  })
})

describe('buildTcpLoadBalancerSpecBody', () => {
  it('builds a plain-TCP body with pool refs and default choices', () => {
    const specs = extractTcpLoadBalancerSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'ssh-lb', listenPort: 22, originPools: ['ssh-pool'] } }]),
    )
    const body = buildTcpLoadBalancerSpecBody(specs[0])
    expect(body.listen_port).toBe(22)
    expect(body.origin_pools_weights).toEqual([{ pool: { name: 'ssh-pool' } }])
    expect(body.tcp).toBe(true)
    expect(body.do_not_advertise).toBe(true)
    expect(body.do_not_retract_cluster).toBe(true)
    expect(body.hash_policy_choice_round_robin).toBe(true)
    expect(body.no_service_policies).toBe(true)
    expect(body.no_sni).toBe(true)
  })

  it('builds a TLS-auto-cert body with active service policies and a custom SNI', () => {
    const specs = extractTcpLoadBalancerSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: 'ssh-lb',
            listenPort: 22,
            originPools: ['ssh-pool'],
            tlsMode: 'tls_tcp_auto_cert',
            servicePoliciesMode: 'active_service_policies',
            activeServicePolicies: ['policy-1'],
            sniMode: 'sni',
            sniValue: 'ssh.example.com',
          },
        },
      ]),
    )
    const body = buildTcpLoadBalancerSpecBody(specs[0])
    expect(body.tls_tcp_auto_cert).toEqual({ no_mtls: true })
    expect(body.active_service_policies).toEqual({ policies: [{ name: 'policy-1' }] })
    expect(body.sni).toEqual({ sni: 'ssh.example.com' })
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'lb1', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'lb1', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
