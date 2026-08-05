import validate, { extractHealthCheckSpecs } from '../validate'
import { buildHealthCheckSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'health-checks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'health-checks',
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
    entityType: 'health-checks',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('F5 XC Health Checks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal HTTP health check', async () => {
    const result = await validate(
      makeCtx([{ name: 'hc1', fields: { name: 'web-health', checkType: 'http', httpPath: '/healthz' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a TCP health check', async () => {
    const result = await validate(
      makeCtx([{ name: 'hc1', fields: { name: 'tcp-health', checkType: 'tcp', interval: 10, timeout: 2 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a UDP/ICMP health check', async () => {
    const result = await validate(makeCtx([{ name: 'hc1', fields: { name: 'ping-health', checkType: 'udp_icmp' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { checkType: 'http' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid (uppercase) name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Web-Health' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects a duplicate name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'web-health', checkType: 'http', httpPath: '/' } },
        { name: 'sec2', fields: { name: 'Web-Health', checkType: 'http', httpPath: '/' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an HTTP check with no path', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-health', checkType: 'http', httpPath: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('httpPath'))).toBe(true)
  })

  it('rejects a non-positive interval', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'web-health', checkType: 'tcp', interval: 0 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('interval') && e.code === 'invalid_number')).toBe(true)
  })

  it('rejects an out-of-range jitterPercent', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'web-health', checkType: 'tcp', jitterPercent: 150 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })
})

describe('extractHealthCheckSpecs', () => {
  it('defaults checkType to http, leaving httpPath unset when the canvas field is blank', () => {
    const specs = extractHealthCheckSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-health' } }]))
    expect(specs[0].checkType).toBe('http')
    expect(specs[0].httpPath).toBeUndefined()
  })

  it('defaults timing fields when unset', () => {
    const specs = extractHealthCheckSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-health' } }]))
    expect(specs[0].interval).toBe(15)
    expect(specs[0].timeout).toBe(3)
    expect(specs[0].healthyThreshold).toBe(2)
    expect(specs[0].unhealthyThreshold).toBe(2)
  })

  it('carries through tcp fields when set', () => {
    const specs = extractHealthCheckSpecs(
      makeCanvas([
        { name: 'sec1', fields: { name: 'tcp-health', checkType: 'tcp', tcpSendPayload: '01', tcpExpectedResponse: '02' } },
      ]),
    )
    expect(specs[0].tcpSendPayload).toBe('01')
    expect(specs[0].tcpExpectedResponse).toBe('02')
  })
})

describe('buildHealthCheckSpecBody', () => {
  it('builds an http_health_check body with use_origin_server_name by default', () => {
    const specs = extractHealthCheckSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'web-health', httpPath: '/healthz' } }]))
    const body = buildHealthCheckSpecBody(specs[0])
    expect(body.http_health_check).toEqual({ path: '/healthz', use_http2: false, use_origin_server_name: true })
    expect(body.interval).toBe(15)
  })

  it('builds an http_health_check body with a custom host header when use_origin_server_name is off', () => {
    const specs = extractHealthCheckSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: 'web-health', httpPath: '/', httpUseOriginServerName: false, httpHostHeader: 'example.com' },
        },
      ]),
    )
    const body = buildHealthCheckSpecBody(specs[0])
    expect(body.http_health_check?.host_header).toBe('example.com')
    expect(body.http_health_check?.use_origin_server_name).toBeUndefined()
  })

  it('builds a tcp_health_check body', () => {
    const specs = extractHealthCheckSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'tcp-health', checkType: 'tcp', tcpSendPayload: 'AB' } }]),
    )
    const body = buildHealthCheckSpecBody(specs[0])
    expect(body.tcp_health_check).toEqual({ send_payload: 'AB' })
    expect(body.http_health_check).toBeUndefined()
  })

  it('builds a udp_icmp_health_check body', () => {
    const specs = extractHealthCheckSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'ping-health', checkType: 'udp_icmp' } }]))
    const body = buildHealthCheckSpecBody(specs[0])
    expect(body.udp_icmp_health_check).toBe(true)
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({
      name: 'web-health',
      description: 'Web health check',
      disable: false,
      labels: { env: 'prod' },
      uid: 'abc123',
      creation_timestamp: '2020-01-01T00:00:00Z',
    })
    expect(stripped).toEqual({
      name: 'web-health',
      description: 'Web health check',
      disable: false,
      labels: { env: 'prod' },
      annotations: undefined,
    })
  })
})
