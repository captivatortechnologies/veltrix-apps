import validate, { extractHttpLoadBalancerSpecs, parseRoutesJson } from '../validate'
import { buildHttpLoadBalancerSpecBody, stripMetadata } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const VALID_ROUTES_JSON = JSON.stringify([
  { path: { prefix: '/api' }, origin_pools: [{ pool: { name: 'api-pool' } }], http_method: 'GET' },
])

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'f5-distributed-cloud',
    customerId: 'cust-1',
    configTypeId: 'http-load-balancers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'f5-distributed-cloud',
      entityType: 'http-load-balancers',
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
    entityType: 'http-load-balancers',
    items: sections,
    sections,
    snapshot: {},
  }
}

const MINIMAL_FIELDS = { name: 'web-lb', domains: ['www.example.com'], defaultRoutePools: ['web-pool'] }

describe('F5 XC HTTP Load Balancers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal load balancer', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: MINIMAL_FIELDS }]))
    expect(result.valid).toBe(true)
  })

  it('validates a load balancer with a valid routes JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, routesJson: VALID_ROUTES_JSON } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { domains: ['x.com'], defaultRoutePools: ['p1'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: MINIMAL_FIELDS }, { name: 'sec2', fields: MINIMAL_FIELDS }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires at least one domain', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-lb', defaultRoutePools: ['p1'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('domains'))).toBe(true)
  })

  it('requires at least one default route pool', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'web-lb', domains: ['x.com'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('defaultRoutePools'))).toBe(true)
  })

  it('requires an App Firewall Policy when wafMode is app_firewall', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, wafMode: 'app_firewall' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('appFirewallName'))).toBe(true)
  })

  it('requires a rate limit threshold when rateLimitMode is rate_limit', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, rateLimitMode: 'rate_limit' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('rateLimitThreshold'))).toBe(true)
  })

  it('requires attached service policies when servicePoliciesMode is active_service_policies', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, servicePoliciesMode: 'active_service_policies' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('activeServicePolicies'))).toBe(true)
  })

  it('rejects an invalid routes JSON', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, routesJson: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })
})

describe('parseRoutesJson', () => {
  it('returns an empty array for blank input', () => {
    expect(parseRoutesJson('')).toEqual([])
  })

  it('parses a valid routes array', () => {
    expect(parseRoutesJson(VALID_ROUTES_JSON)).toHaveLength(1)
  })

  it('returns null when origin_pools is missing', () => {
    expect(parseRoutesJson(JSON.stringify([{ path: { prefix: '/' } }]))).toBeNull()
  })
})

describe('extractHttpLoadBalancerSpecs', () => {
  it('defaults tlsMode/loadBalancingAlgorithm/wafMode/maliciousUserDetectionMode/rateLimitMode/servicePoliciesMode/advertiseMode', () => {
    const specs = extractHttpLoadBalancerSpecs(makeCanvas([{ name: 'sec1', fields: { name: 'lb1' } }]))
    expect(specs[0].tlsMode).toBe('https_auto_cert')
    expect(specs[0].loadBalancingAlgorithm).toBe('round_robin')
    expect(specs[0].wafMode).toBe('disable_waf')
    expect(specs[0].maliciousUserDetectionMode).toBe('disable_malicious_user_detection')
    expect(specs[0].rateLimitMode).toBe('disable_rate_limit')
    expect(specs[0].servicePoliciesMode).toBe('no_service_policies')
    expect(specs[0].advertiseMode).toBe('do_not_advertise')
    expect(specs[0].httpRedirect).toBe(true)
  })
})

describe('buildHttpLoadBalancerSpecBody', () => {
  it('builds a default https_auto_cert body', () => {
    const specs = extractHttpLoadBalancerSpecs(makeCanvas([{ name: 'sec1', fields: MINIMAL_FIELDS }]))
    const body = buildHttpLoadBalancerSpecBody(specs[0])
    expect(body?.domains).toEqual(['www.example.com'])
    expect(body?.default_route_pools).toEqual([{ pool: { name: 'web-pool' } }])
    expect(body?.https_auto_cert).toEqual({ http_redirect: true, port: 443 })
    expect(body?.round_robin).toBe(true)
    expect(body?.disable_waf).toBe(true)
    expect(body?.disable_malicious_user_detection).toBe(true)
    expect(body?.disable_rate_limit).toBe(true)
    expect(body?.no_service_policies).toBe(true)
    expect(body?.do_not_advertise).toBe(true)
    expect(body?.cors_policy).toBeUndefined()
    expect(body?.routes).toBeUndefined()
  })

  it('builds a plain-HTTP body', () => {
    const specs = extractHttpLoadBalancerSpecs(makeCanvas([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, tlsMode: 'http', httpPort: 8080 } }]))
    const body = buildHttpLoadBalancerSpecBody(specs[0])
    expect(body?.http).toEqual({ port: 8080 })
    expect(body?.https_auto_cert).toBeUndefined()
  })

  it('attaches a WAF policy, malicious user mitigation, rate limiting, CORS and routes', () => {
    const specs = extractHttpLoadBalancerSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            ...MINIMAL_FIELDS,
            wafMode: 'app_firewall',
            appFirewallName: 'waf-1',
            maliciousUserDetectionMode: 'enable_malicious_user_detection',
            maliciousUserMitigationName: 'mitigation-1',
            rateLimitMode: 'rate_limit',
            rateLimitThreshold: 100,
            rateLimitUnit: 'MINUTE',
            corsEnabled: true,
            corsAllowOrigin: ['https://app.example.com'],
            corsAllowCredentials: true,
            routesJson: VALID_ROUTES_JSON,
          },
        },
      ]),
    )
    const body = buildHttpLoadBalancerSpecBody(specs[0])
    expect(body?.app_firewall).toEqual({ name: 'waf-1' })
    expect(body?.enable_malicious_user_detection).toBe(true)
    expect(body?.malicious_user_mitigation).toEqual({ name: 'mitigation-1' })
    expect(body?.rate_limit).toEqual({
      no_policies: true,
      no_ip_allowed_list: true,
      rate_limiter: { use_http_lb_user_id: true, threshold: 100, unit: 'MINUTE' },
    })
    expect(body?.cors_policy).toEqual({
      disabled: false,
      allow_origin: ['https://app.example.com'],
      allow_credentials: true,
    })
    expect(body?.routes).toEqual([
      { simple_route: { path: { prefix: '/api' }, origin_pools: [{ pool: { name: 'api-pool' } }], http_method: 'GET' } },
    ])
  })

  it('returns null for an invalid routes JSON', () => {
    const specs = extractHttpLoadBalancerSpecs(makeCanvas([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, routesJson: 'bad' } }]))
    expect(buildHttpLoadBalancerSpecBody(specs[0])).toBeNull()
  })
})

describe('stripMetadata', () => {
  it('keeps only name/description/disable/labels/annotations', () => {
    const stripped = stripMetadata({ name: 'lb1', description: 'desc', disable: false, uid: 'abc' })
    expect(stripped).toEqual({ name: 'lb1', description: 'desc', disable: false, labels: undefined, annotations: undefined })
  })
})
