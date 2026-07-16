import validate, { extractIncidentTypeSpecs, isProtectedType } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-incident-types',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-incident-types',
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

describe('Cortex XSOAR Incident Types Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid incident type', async () => {
    const result = await validate(makeCtx([{ name: 'T1', fields: { name: 'Phishing', color: '#29B473' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { color: '#000000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Phishing' } },
        { name: 'b', fields: { name: 'Phishing' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_type')).toBe(true)
  })

  it('rejects a non-hex color', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Phishing', color: 'red' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_color')).toBe(true)
  })

  it('warns on auto-run without a playbook', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Phishing', autorun: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'autorun_without_playbook')).toBe(true)
  })

  it('extractIncidentTypeSpecs trims the name and defaults flags to false', () => {
    const specs = extractIncidentTypeSpecs(makeCtx([{ name: 's', fields: { name: '  Phishing  ' } }]).canvas)
    expect(specs[0].name).toBe('Phishing')
    expect(specs[0].autorun).toBe(false)
    expect(specs[0].disabled).toBe(false)
  })

  it('isProtectedType detects system and locked types', () => {
    expect(isProtectedType({ name: 'Unclassified', system: true })).toBe(true)
    expect(isProtectedType({ name: 'Legacy', locked: true })).toBe(true)
    expect(isProtectedType({ name: 'Phishing' })).toBe(false)
  })
})
