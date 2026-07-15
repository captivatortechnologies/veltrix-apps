import validate, {
  checkZoneDefinition,
  extractZoneSpecs,
  isProtectedZoneName,
  parseConfigObject,
} from '../validate'
import { buildZoneBody, stripReadOnlyZoneFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'network-zones',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'network-zones',
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
    toolType: 'okta-identity',
    entityType: 'network-zones',
    items: sections,
    sections,
    snapshot: {},
  }
}

const IP_CONFIG = '{"gateways":[{"type":"CIDR","value":"1.2.3.0/24"}]}'
const DYNAMIC_CONFIG = '{"asns":["16509"],"locations":[{"country":"US","region":"US-CA"}],"proxyType":"Any"}'
const DYNAMIC_V2_CONFIG = '{"ipServiceCategories":[{"ipService":"TOR_ANONYMIZER"}]}'

describe('Okta Network Zones Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IP zone', async () => {
    const result = await validate(
      makeCtx([{ name: 'Zone', fields: { type: 'IP', name: 'Office CIDR', status: 'ACTIVE', configJson: IP_CONFIG } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid DYNAMIC zone', async () => {
    const result = await validate(
      makeCtx([{ name: 'Zone', fields: { type: 'DYNAMIC', name: 'Geo Block', configJson: DYNAMIC_CONFIG } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid DYNAMIC_V2 zone', async () => {
    const result = await validate(
      makeCtx([{ name: 'Zone', fields: { type: 'DYNAMIC_V2', name: 'Tor Block', configJson: DYNAMIC_V2_CONFIG } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'IP', configJson: IP_CONFIG } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 128 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'x'.repeat(129), configJson: IP_CONFIG } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Type', configJson: IP_CONFIG } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unknown zone type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'MAGIC', name: 'Bad Type', configJson: IP_CONFIG } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an invalid status', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'Bad Status', status: 'PAUSED', configJson: IP_CONFIG } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects each protected system zone name', async () => {
    for (const name of ['LegacyIpZone', 'BlockedIpZone', 'DefaultEnhancedDynamicZone', 'DefaultExemptIpZone']) {
      const result = await validate(
        makeCtx([{ name: 'sec1', fields: { type: 'IP', name, configJson: IP_CONFIG } }]),
      )
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'protected_zone')).toBe(true)
    }
  })

  it('rejects a protected zone name case-insensitively', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'blockedipzone', configJson: IP_CONFIG } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'protected_zone')).toBe(true)
  })

  it('rejects malformed definition JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'Bad JSON', configJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects a definition that is a JSON array, not an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'Array Def', configJson: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_config')).toBe(true)
  })

  it('rejects an IP zone with neither gateways nor proxies', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'Empty IP', configJson: '{"gateways":[]}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_definition')).toBe(true)
  })

  it('rejects a DYNAMIC zone with no asns/locations/proxyType', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'DYNAMIC', name: 'Empty Dyn', configJson: '{"asns":[]}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_definition')).toBe(true)
  })

  it('rejects a DYNAMIC_V2 zone with no asns/locations/ipServiceCategories', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'DYNAMIC_V2', name: 'Empty V2', configJson: '{"locations":[]}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_definition')).toBe(true)
  })

  it('rejects an IP zone with a missing definition entirely', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'IP', name: 'No Def' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_definition')).toBe(true)
  })

  it('accepts an IP zone defined by proxies only', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { type: 'IP', name: 'Proxy Zone', configJson: '{"proxies":[{"type":"CIDR","value":"10.0.0.0/8"}]}' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('accepts a DYNAMIC zone defined by proxyType only', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { type: 'DYNAMIC', name: 'Tor Only', configJson: '{"proxyType":"Tor"}' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate zone name (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { type: 'IP', name: 'Office', configJson: IP_CONFIG } },
        { name: 'sec2', fields: { type: 'IP', name: 'office', configJson: IP_CONFIG } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractZoneSpecs', () => {
  it('trims fields, upper-cases the type/status and drops a blank config', () => {
    const specs = extractZoneSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { type: '  ip  ', name: '  Office CIDR  ', status: ' inactive ', configJson: '   ' },
        },
      ]),
    )
    expect(specs[0].type).toBe('IP')
    expect(specs[0].name).toBe('Office CIDR')
    expect(specs[0].status).toBe('INACTIVE')
    expect(specs[0].configJson).toBeUndefined()
  })

  it('defaults status to ACTIVE when unset', () => {
    const specs = extractZoneSpecs(makeCanvas([{ name: 'sec1', fields: { type: 'IP', name: 'Z' } }]))
    expect(specs[0].status).toBe('ACTIVE')
  })
})

describe('parseConfigObject', () => {
  it('parses a JSON object', () => {
    expect(parseConfigObject('{"a":1}')).toEqual({ a: 1 })
  })
  it('rejects a JSON array', () => {
    expect(parseConfigObject('[1,2]')).toBe(null)
  })
  it('rejects malformed JSON', () => {
    expect(parseConfigObject('{nope')).toBe(null)
  })
})

describe('isProtectedZoneName', () => {
  it('matches the four system zones case-insensitively', () => {
    expect(isProtectedZoneName('LegacyIpZone')).toBe(true)
    expect(isProtectedZoneName('  defaultexemptipzone  ')).toBe(true)
    expect(isProtectedZoneName('My Office Zone')).toBe(false)
  })
})

describe('checkZoneDefinition', () => {
  it('passes an IP zone with gateways and fails an empty one', () => {
    expect(checkZoneDefinition('IP', { gateways: [{ type: 'CIDR', value: '1.2.3.0/24' }] })).toBeNull()
    expect(checkZoneDefinition('IP', {})).toMatch(/gateways/)
  })
  it('passes a DYNAMIC zone with locations and fails an empty one', () => {
    expect(checkZoneDefinition('DYNAMIC', { locations: [{ country: 'US' }] })).toBeNull()
    expect(checkZoneDefinition('DYNAMIC', {})).toMatch(/asns/)
  })
})

describe('buildZoneBody', () => {
  it('merges the IP definition and lets the modeled fields win over the blob', () => {
    const body = buildZoneBody(
      { sectionName: 's', type: 'IP', name: 'Office CIDR', status: 'ACTIVE' },
      { gateways: [{ type: 'CIDR', value: '1.2.3.0/24' }], name: 'HIJACK', type: 'DYNAMIC' },
    )
    expect(body).toEqual({
      type: 'IP',
      name: 'Office CIDR',
      status: 'ACTIVE',
      gateways: [{ type: 'CIDR', value: '1.2.3.0/24' }],
    })
  })

  it('merges the DYNAMIC definition arrays into the body', () => {
    const body = buildZoneBody(
      { sectionName: 's', type: 'DYNAMIC', name: 'Geo', status: 'INACTIVE' },
      { asns: ['16509'], locations: [{ country: 'US', region: 'US-CA' }], proxyType: 'Any' },
    )
    expect(body).toEqual({
      type: 'DYNAMIC',
      name: 'Geo',
      status: 'INACTIVE',
      asns: ['16509'],
      locations: [{ country: 'US', region: 'US-CA' }],
      proxyType: 'Any',
    })
  })
})

describe('stripReadOnlyZoneFields', () => {
  it('removes id/created/lastUpdated/system/_links/_embedded/status but keeps the definition', () => {
    const stripped = stripReadOnlyZoneFields({
      id: 'nzoabc',
      name: 'Office',
      type: 'IP',
      status: 'ACTIVE',
      system: false,
      created: '2020-01-01T00:00:00Z',
      lastUpdated: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      _embedded: {},
      gateways: [{ type: 'CIDR', value: '1.2.3.0/24' }],
    })
    expect(stripped).toEqual({
      name: 'Office',
      type: 'IP',
      gateways: [{ type: 'CIDR', value: '1.2.3.0/24' }],
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.status).toBeUndefined()
  })
})
