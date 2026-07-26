import validate, {
  extractAntiSpywareSpecs,
  buildAntiSpywareFields,
  antiSpywareDriftDiffs,
  liveActionName,
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
    configTypeId: 'panorama-anti-spyware-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-anti-spyware-profiles',
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

describe('Panorama Anti-Spyware Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a block-critical-high-medium profile', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'strict', severity: ['critical', 'high', 'medium'], action: 'reset-both' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported severity', async () => {
    const result = await validate(makeCtx([{ name: 's', fields: { name: 'strict', severity: ['catastrophic'], action: 'alert' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('builds a single rule with a choice-element action', () => {
    const spec = extractAntiSpywareSpecs(makeCtx([{ name: 's', fields: { name: 'strict', severity: ['critical', 'high'], action: 'reset-both', packet_capture: 'single-packet' } }]).canvas)[0]
    const fields = buildAntiSpywareFields(spec) as { rules: { entry: Array<Record<string, unknown>> } }
    const rule = fields.rules.entry[0]
    expect(rule.action).toEqual({ 'reset-both': {} })
    expect(rule.severity).toEqual({ member: ['critical', 'high'] })
    expect(rule['packet-capture']).toBe('single-packet')
    expect(rule.category).toBe('any')
    expect(rule['threat-name']).toBe('any')
  })

  it('reads the action name from a choice object or a bare string', () => {
    expect(liveActionName({ 'reset-both': {} })).toBe('reset-both')
    expect(liveActionName('alert')).toBe('alert')
    expect(liveActionName(undefined)).toBe('')
  })

  it('detects a drifted action and a missing rule', () => {
    const spec = extractAntiSpywareSpecs(makeCtx([{ name: 's', fields: { name: 'strict', severity: ['critical', 'high', 'medium'], action: 'reset-both' } }]).canvas)[0]
    const clean = antiSpywareDriftDiffs(spec, {
      '@name': 'strict',
      rules: { entry: [{ '@name': 'block-critical-high-medium', action: { 'reset-both': {} }, severity: { member: ['medium', 'critical', 'high'] }, category: 'any', 'threat-name': 'any', 'packet-capture': 'disable' }] },
    })
    expect(clean).toHaveLength(0)
    const drifted = antiSpywareDriftDiffs(spec, {
      '@name': 'strict',
      rules: { entry: [{ '@name': 'block-critical-high-medium', action: { alert: {} }, severity: { member: ['critical', 'high', 'medium'] } }] },
    })
    expect(drifted.some((d) => d.field.endsWith('.action'))).toBe(true)
    const missing = antiSpywareDriftDiffs(spec, { '@name': 'strict', rules: { entry: [] } })
    expect(missing.some((d) => d.severity === 'critical')).toBe(true)
  })
})
