import validate, { extractThreatInsightSpecs, splitList } from '../validate'
import { buildThreatInsightBody, type ThreatInsightRollbackData } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'okta-identity',
    customerId: 'cust-1',
    configTypeId: 'threat-insight',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'okta-identity',
      entityType: 'threat-insight',
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
    entityType: 'threat-insight',
    items: sections,
    sections,
    snapshot: {},
  }
}

describe('Okta ThreatInsight Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid config (audit + exempt zones)', async () => {
    const result = await validate(
      makeCtx([{ name: 'ThreatInsight', fields: { action: 'audit', excludeZones: ['nzo1', 'nzo2'] } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts a config with no exempt zones', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'block' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { excludeZones: ['nzo1'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('action'))).toBe(true)
  })

  it('rejects an invalid action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'quarantine' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects more than one configuration (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { action: 'audit' } },
        { name: 'sec2', fields: { action: 'block' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })
})

describe('extractThreatInsightSpecs', () => {
  it('lower-cases the action and de-dupes exempt zones', () => {
    const specs = extractThreatInsightSpecs(
      makeCanvas([{ name: 'sec1', fields: { action: ' BLOCK ', excludeZones: ['nzo1', 'nzo1', ' nzo2 '] } }]),
    )
    expect(specs[0].action).toBe('block')
    expect(specs[0].excludeZones).toEqual(['nzo1', 'nzo2'])
  })
})

describe('buildThreatInsightBody', () => {
  it('always sends action and excludeZones (empty array clears exemptions)', () => {
    expect(buildThreatInsightBody({ sectionName: 's', action: 'none', excludeZones: [] })).toEqual({
      action: 'none',
      excludeZones: [],
    })
  })
})

describe('splitList', () => {
  it('handles arrays and delimited strings', () => {
    expect(splitList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(splitList('a,b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(42)).toEqual([])
  })
})

// Type-only reference so the rollback data shape stays in sync with deploy.
const _rollbackDataType: ThreatInsightRollbackData | null = null
void _rollbackDataType
