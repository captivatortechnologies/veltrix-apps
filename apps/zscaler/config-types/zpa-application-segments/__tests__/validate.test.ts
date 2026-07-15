import validate, {
  extractApplicationSegmentSpecs,
  parsePortRange,
  readBool,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zpa-application-segments',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zpa-application-segments',
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

/** A fully-populated, valid application segment section. */
function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Corp App',
    domain_names: 'app.corp.example\n*.corp.example',
    segment_group_name: 'Corp Apps',
    server_group_names: 'Primary SG\nSecondary SG',
    tcp_port_ranges: '443\n8080-8090',
    udp_port_ranges: '',
    bypass_type: 'NEVER',
    health_reporting: 'ON_ACCESS',
    ...overrides,
  }
}

describe('ZPA Application Segments Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully-populated application segment', async () => {
    const result = await validate(makeCtx([{ name: 'Application Segment', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: validFields({ name: 'Corp App' }) },
        { name: 'b', fields: validFields({ name: 'corp app' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_application_segment')).toBe(true)
  })

  it('rejects a segment with no domain names', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields({ domain_names: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('domain_names'))).toBe(true)
  })

  it('rejects a missing segment group name', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields({ segment_group_name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('segment_group_name'))).toBe(true)
  })

  it('rejects a segment with no server group names', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields({ server_group_names: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('server_group_names'))).toBe(true)
  })

  it('rejects a segment with no TCP or UDP port ranges', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields({ tcp_port_ranges: '', udp_port_ranges: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('tcp_port_ranges'))).toBe(true)
  })

  it('rejects an out-of-range / malformed port range', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields({ tcp_port_ranges: '443\n70000', udp_port_ranges: 'abc' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port_range')).toBe(true)
  })

  it('parses single ports and ranges, rejecting invalid ones', () => {
    expect(parsePortRange('443')).toEqual({ from: '443', to: '443' })
    expect(parsePortRange('8080-8090')).toEqual({ from: '8080', to: '8090' })
    expect(parsePortRange('  53 ')).toEqual({ from: '53', to: '53' })
    expect(parsePortRange('443-80')).toBeNull() // from > to
    expect(parsePortRange('0')).toBeNull() // below 1
    expect(parsePortRange('70000')).toBeNull() // above 65535
    expect(parsePortRange('abc')).toBeNull()
    expect(parsePortRange('80-')).toBeNull()
  })

  it('defaults enabled to true and normalises select fields', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    const specs = extractApplicationSegmentSpecs(
      makeCtx([{ name: 'g', fields: { name: 'X', bypass_type: 'nonsense' } }]).canvas,
    )
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].bypassType).toBe('NEVER')
    expect(specs[0].healthReporting).toBe('ON_ACCESS')
  })
})
