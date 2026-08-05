import validate, { extractOriginPoolSpecs, parseOriginServers } from '../validate'
import { buildOriginPoolSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_ORIGIN_SERVERS_JSON = JSON.stringify([{ public_ip: { ip: '203.0.113.10' } }])

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'origin-pools',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'origin-pools',
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
    entityType: 'origin-pools',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC Origin Pools Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal pool with a fixed port', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'web-pool', port: 443, originServersJson: VALID_ORIGIN_SERVERS_JSON } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { originServersJson: VALID_ORIGIN_SERVERS_JSON, port: 443 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const fields = { name: 'web-pool', port: 443, originServersJson: VALID_ORIGIN_SERVERS_JSON }
    const result = await validate(makeCtx([{ name: 'sec1', fields }, { name: 'sec2', fields }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires a port when portMode is "port"', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'web-pool', portMode: 'port', originServersJson: VALID_ORIGIN_SERVERS_JSON } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('port'))).toBe(true)
  })

  it('does not require a port when portMode is automatic_port', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'web-pool', portMode: 'automatic_port', originServersJson: VALID_ORIGIN_SERVERS_JSON } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects invalid Origin Servers JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-pool', port: 443, originServersJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an empty Origin Servers array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-pool', port: 443, originServersJson: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })
})

describe('parseOriginServers', () => {
  it('parses a valid JSON array of objects', () => {
    expect(parseOriginServers(VALID_ORIGIN_SERVERS_JSON)).toEqual([{ public_ip: { ip: '203.0.113.10' } }])
  })

  it('returns null for blank input', () => {
    expect(parseOriginServers('')).toBeNull()
  })

  it('returns null for a non-array', () => {
    expect(parseOriginServers('{"public_ip":{"ip":"1.2.3.4"}}')).toBeNull()
  })
})

describe('extractOriginPoolSpecs', () => {
  it('defaults endpointSelection, loadbalancerAlgorithm, portMode and tlsMode', () => {
    const specs = extractOriginPoolSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-pool' } }]))
    expect(specs[0].endpointSelection).toBe('LOCAL_PREFERRED')
    expect(specs[0].loadbalancerAlgorithm).toBe('ROUND_ROBIN')
    expect(specs[0].portMode).toBe('port')
    expect(specs[0].tlsMode).toBe('no_tls')
  })

  it('carries through healthChecks', () => {
    const specs = extractOriginPoolSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-pool', healthChecks: ['hc1', 'hc2'] } }]))
    expect(specs[0].healthChecks).toEqual(['hc1', 'hc2'])
  })
})

describe('buildOriginPoolSpecBody', () => {
  it('builds a body with automatic_port and no_tls by default', () => {
    const specs = extractOriginPoolSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'web-pool', portMode: 'automatic_port', originServersJson: VALID_ORIGIN_SERVERS_JSON } }]),
    )
    const body = buildOriginPoolSpecBody(specs[0])
    expect(body?.automatic_port).toBe(true)
    expect(body?.no_tls).toBe(true)
    expect(body?.origin_servers).toEqual([{ public_ip: { ip: '203.0.113.10' } }])
  })

  it('attaches health check refs when set', () => {
    const specs = extractOriginPoolSpecs(
      makeCanvas([
        { name: 'sec1', fields: { name: 'web-pool', port: 443, healthChecks: ['hc1'], originServersJson: VALID_ORIGIN_SERVERS_JSON } },
      ]),
    )
    const body = buildOriginPoolSpecBody(specs[0])
    expect(body?.healthcheck).toEqual([{ name: 'hc1' }])
  })

  it('returns null for invalid Origin Servers JSON', () => {
    const specs = extractOriginPoolSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-pool', originServersJson: 'nope' } }]))
    expect(buildOriginPoolSpecBody(specs[0])).toBeNull()
  })

  it('builds a use_tls body with default trusted CA verification', () => {
    const specs = extractOriginPoolSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'web-pool', port: 443, tlsMode: 'use_tls', originServersJson: VALID_ORIGIN_SERVERS_JSON } }]),
    )
    const body = buildOriginPoolSpecBody(specs[0])
    expect((body?.use_tls as Record<string, unknown>)?.volterra_trusted_ca).toBe(true)
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'web-pool', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'web-pool', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
