import validate, {
  extractIndicatorSpecs,
  indicatorKey,
  normalizePattern,
  resolvePatternType,
  MANAGED_SOURCE,
} from '../validate'
import { buildIndicatorBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-threat-indicators',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-threat-indicators',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const validIndicator = {
  display_name: 'Known bad IP 1.2.3.4',
  description: 'Command-and-control host',
  pattern_type: 'ipv4-addr',
  pattern: '1.2.3.4',
  confidence: 80,
  threat_types: ['malicious-activity', 'c2'],
  tags: ['apt29'],
  valid_from: '2024-01-31T00:00:00Z',
  valid_until: '2024-12-31T00:00:00Z',
  revoked: false,
}

describe('Sentinel Threat Indicators Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete indicator', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validIndicator } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a display name and a pattern', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validIndicator, display_name: '', pattern: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.display_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.pattern') && e.code === 'required')).toBe(true)
  })

  it('rejects an unknown pattern type', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validIndicator, pattern_type: 'mac-addr' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_pattern_type')).toBe(true)
  })

  it('rejects a confidence outside 0-100', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validIndicator, confidence: 150 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_confidence')).toBe(true)
  })

  it('rejects a non ISO-8601 valid-from', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validIndicator, valid_from: '31 January 2024' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.valid_from') && e.code === 'invalid_datetime')).toBe(true)
  })

  it('rejects a validity window where valid-until precedes valid-from', async () => {
    const result = await validate(
      makeCtx([{ name: 'i', fields: { ...validIndicator, valid_from: '2024-12-31T00:00:00Z', valid_until: '2024-01-01T00:00:00Z' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_validity_window')).toBe(true)
  })

  it('rejects duplicate display names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validIndicator, display_name: 'Known bad IP' } },
        { name: 'b', fields: { ...validIndicator, display_name: 'known bad ip' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_indicator')).toBe(true)
  })

  it('wraps a bare value into a STIX pattern and resolves the STIX type', () => {
    const specs = extractIndicatorSpecs(makeCtx([{ name: 'i', fields: { ...validIndicator } }]).canvas)
    expect(specs[0].pattern).toBe("[ipv4-addr:value = '1.2.3.4']")
    expect(specs[0].stixType).toBe('ipv4-addr')
    expect(specs[0].threatTypes).toEqual(['malicious-activity', 'c2'])
    expect(indicatorKey('Known Bad IP 1.2.3.4')).toBe('known bad ip 1.2.3.4')
  })

  it('wraps a file hash into a file:hashes STIX pattern with STIX type "file"', () => {
    const specs = extractIndicatorSpecs(
      makeCtx([{ name: 'i', fields: { ...validIndicator, pattern_type: 'file:sha256', pattern: 'ABC123' } }]).canvas,
    )
    expect(specs[0].pattern).toBe("[file:hashes.'SHA-256' = 'ABC123']")
    expect(specs[0].stixType).toBe('file')
  })

  it('keeps a full STIX pattern verbatim', () => {
    expect(normalizePattern("[url:value = 'https://bad.example.com']", resolvePatternType('url'))).toBe(
      "[url:value = 'https://bad.example.com']",
    )
    const specs = extractIndicatorSpecs(
      makeCtx([{ name: 'i', fields: { ...validIndicator, pattern_type: 'url', pattern: "[url:value = 'https://bad.example.com']" } }]).canvas,
    )
    expect(specs[0].pattern).toBe("[url:value = 'https://bad.example.com']")
  })

  it('builds an indicator body scoped to the managed source with mapped properties', () => {
    const specs = extractIndicatorSpecs(makeCtx([{ name: 'i', fields: { ...validIndicator } }]).canvas)
    const body = buildIndicatorBody(specs[0]) as { kind: string; properties: Record<string, unknown> }
    expect(body.kind).toBe('indicator')
    expect(body.properties.source).toBe(MANAGED_SOURCE)
    expect(body.properties.displayName).toBe('Known bad IP 1.2.3.4')
    expect(body.properties.pattern).toBe("[ipv4-addr:value = '1.2.3.4']")
    expect(body.properties.patternType).toBe('ipv4-addr')
    expect(body.properties.confidence).toBe(80)
    expect(body.properties.threatIntelligenceTags).toEqual(['apt29'])
    expect(body.properties.validUntil).toBe('2024-12-31T00:00:00Z')
  })

  it('defaults validFrom to the fallback when blank and omits blank validUntil', () => {
    const specs = extractIndicatorSpecs(
      makeCtx([{ name: 'i', fields: { ...validIndicator, valid_from: '', valid_until: '' } }]).canvas,
    )
    const body = buildIndicatorBody(specs[0], { validFromFallback: '2023-06-01T00:00:00Z' }) as {
      properties: Record<string, unknown>
    }
    expect(body.properties.validFrom).toBe('2023-06-01T00:00:00Z')
    expect(body.properties.validUntil).toBeUndefined()
  })
})
