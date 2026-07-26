import validate, {
  extractAntivirusSpecs,
  buildAntivirusFields,
  antivirusDriftDiffs,
  AV_DECODERS,
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
    configTypeId: 'panorama-antivirus-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-antivirus-profiles',
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

describe('Panorama Antivirus Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a reset-both profile', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'strict', action: 'reset-both', wildfire_action: 'reset-both' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'x', action: 'nuke' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('applies the chosen actions to every decoder', () => {
    const spec = extractAntivirusSpecs(makeCtx([{ name: 'a', fields: { name: 'strict', action: 'reset-both', wildfire_action: 'alert' } }]).canvas)[0]
    const fields = buildAntivirusFields(spec) as { decoder: { entry: Array<{ '@name': string; action: string; 'wildfire-action': string }> } }
    expect(fields.decoder.entry).toHaveLength(AV_DECODERS.length)
    expect(fields.decoder.entry.every((d) => d.action === 'reset-both' && d['wildfire-action'] === 'alert')).toBe(true)
    expect(fields.decoder.entry.map((d) => d['@name'])).toEqual([...AV_DECODERS])
  })

  it('detects a decoder whose action drifted', () => {
    const spec = extractAntivirusSpecs(makeCtx([{ name: 'a', fields: { name: 'strict', action: 'reset-both', wildfire_action: 'reset-both' } }]).canvas)[0]
    const clean = antivirusDriftDiffs(spec, {
      '@name': 'strict',
      decoder: { entry: AV_DECODERS.map((n) => ({ '@name': n, action: 'reset-both', 'wildfire-action': 'reset-both' })) },
    })
    expect(clean).toHaveLength(0)
    const drifted = antivirusDriftDiffs(spec, {
      '@name': 'strict',
      decoder: { entry: [{ '@name': 'smtp', action: 'alert', 'wildfire-action': 'reset-both' }] },
    })
    expect(drifted.some((d) => d.field === 'strict.smtp.action')).toBe(true)
  })
})
