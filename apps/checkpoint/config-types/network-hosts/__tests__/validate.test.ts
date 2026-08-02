import validate, {
  extractHostSpecs,
  hostKey,
  isValidIpv4,
  isValidIpv6,
  liveTagNames,
  sameStringSet,
  strList,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'checkpoint',
    customerId: 'cust-1',
    configTypeId: 'network-hosts',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'checkpoint',
      entityType: 'network-hosts',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = { name: 'web-01', ipv4Address: '10.0.0.5' }

describe('Check Point Network Hosts Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a host with an IPv4 address', async () => {
    const result = await validate(makeCtx([{ name: 'Host', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a host with only an IPv6 address', async () => {
    const result = await validate(
      makeCtx([{ name: 'Host', fields: { name: 'v6-host', ipv6Address: '2001:db8::1' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a dual-stack host', async () => {
    const result = await validate(
      makeCtx([{ name: 'Host', fields: { name: 'dual', ipv4Address: '10.0.0.5', ipv6Address: '2001:db8::1' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: '', fields: { ipv4Address: '10.0.0.5' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires at least one IP address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'no-ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('ipv4Address'))).toBe(true)
  })

  it('rejects an invalid IPv4 address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', ipv4Address: '999.0.0.1' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_ip' && e.field.includes('ipv4Address'))).toBe(true)
  })

  it('rejects an invalid IPv6 address', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'bad', ipv6Address: 'not-an-ip' } }]))
    expect(result.errors.some((e) => e.code === 'invalid_ip' && e.field.includes('ipv6Address'))).toBe(true)
  })

  it('rejects duplicate host names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Web-01' } },
        { name: 'b', fields: { ...validFields, name: 'web-01' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts a host with tags (blank tag entries are dropped, not rejected)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, tags: ['prod', '', 'dmz'] } }]))
    expect(result.valid).toBe(true)
  })

  it('extractHostSpecs trims fields and reads tag lists', () => {
    const specs = extractHostSpecs(
      makeCtx([
        {
          name: 'e',
          fields: { name: '  web-02  ', ipv4Address: ' 10.0.0.9 ', tags: ['prod', '  dmz  '] },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('web-02')
    expect(specs[0].ipv4Address).toBe('10.0.0.9')
    expect(specs[0].tags).toEqual(['prod', 'dmz'])
    expect(hostKey('  Web-02 ')).toBe('web-02')
  })
})

describe('strList', () => {
  it('handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })
})

describe('isValidIpv4', () => {
  it('accepts valid addresses', () => {
    expect(isValidIpv4('10.0.0.1')).toBe(true)
    expect(isValidIpv4('255.255.255.255')).toBe(true)
    expect(isValidIpv4('0.0.0.0')).toBe(true)
  })

  it('rejects invalid addresses', () => {
    expect(isValidIpv4('256.0.0.1')).toBe(false)
    expect(isValidIpv4('10.0.0')).toBe(false)
    expect(isValidIpv4('not-an-ip')).toBe(false)
  })
})

describe('isValidIpv6', () => {
  it('accepts common forms', () => {
    expect(isValidIpv6('2001:db8::1')).toBe(true)
    expect(isValidIpv6('::1')).toBe(true)
    expect(isValidIpv6('fe80::1%eth0')).toBe(true)
    expect(isValidIpv6('::ffff:192.0.2.1')).toBe(true)
  })

  it('rejects invalid forms', () => {
    expect(isValidIpv6('not-an-ip')).toBe(false)
    expect(isValidIpv6('10.0.0.1')).toBe(false)
  })
})

describe('liveTagNames', () => {
  it('flattens string and object-summary tags', () => {
    expect(liveTagNames(['prod', { name: 'dmz' }])).toEqual(['prod', 'dmz'])
  })

  it('tolerates a missing tags array', () => {
    expect(liveTagNames(undefined)).toEqual([])
  })
})

describe('sameStringSet', () => {
  it('is order- and case-insensitive', () => {
    expect(sameStringSet(['Prod', 'dmz'], ['dmz', 'prod'])).toBe(true)
    expect(sameStringSet(['prod'], ['prod', 'dmz'])).toBe(false)
  })
})
