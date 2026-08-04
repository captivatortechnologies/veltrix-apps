import validate, { controlKey, extractControlSpecs, jsonEquals, liveProjectId, readBool, tryParseJson } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-controls',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-controls',
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

const validFields = {
  name: 'Publicly exposed VM with critical vulnerability',
  severity: 'CRITICAL',
  scope_query: JSON.stringify({ type: ['VIRTUAL_MACHINE'] }),
  query: JSON.stringify({ where: { hasCriticalVulnerability: true } }),
}

describe('Wiz Controls Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid control', async () => {
    const result = await validate(makeCtx([{ name: 'C1', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name, query and scope_query', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('query'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('scope_query'))).toBe(true)
  })

  it('rejects malformed query JSON', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { ...validFields, query: '[not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json' && e.field.includes('.query'))).toBe(true)
  })

  it('rejects an unsupported severity', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { ...validFields, severity: 'EXTREME' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects duplicate control names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Dup Control' } },
        { name: 'b', fields: { ...validFields, name: 'dup control' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_control')).toBe(true)
  })

  it('extractControlSpecs trims, defaults severity/project and parses JSON', () => {
    const specs = extractControlSpecs(makeCtx([{ name: 'e', fields: { ...validFields, name: '  Ctl  ' } }]).canvas)
    expect(specs[0].name).toBe('Ctl')
    expect(specs[0].severity).toBe('CRITICAL')
    expect(specs[0].projectId).toBe('*')
    expect(specs[0].enabled).toBe(true)
    expect(controlKey('  Ctl ')).toBe('ctl')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('[bad').ok).toBe(false)
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false)
    expect(liveProjectId(null)).toBe('*')
    expect(liveProjectId({ id: 'proj-1' })).toBe('proj-1')
  })
})
