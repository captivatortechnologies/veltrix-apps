import validate, { extractTemplateSpecs, templateKey, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-scan-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-scan-templates',
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

describe('InsightVM Scan Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a full scan template with template config JSON', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Scan Template',
          fields: {
            template_id: 'my-full-audit',
            name: 'My Full Audit',
            description: 'All checks, no web spider',
            template_json: '{"checks":{"categories":{"enabled":["CIFS"]}}}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('is valid when template_json is blank', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { template_id: 'bare', name: 'Bare' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing template_id and name', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { description: 'orphan' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('template_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects invalid template_json (array)', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { template_id: 'x', name: 'X', template_json: '[1,2]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects invalid template_json (malformed)', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { template_id: 'x', name: 'X', template_json: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a duplicate template_id', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { template_id: 'audit', name: 'One' } },
        { name: 'b', fields: { template_id: 'audit', name: 'Two' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_template')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseJsonObject('  ').error).toBeNull()
    expect(parseJsonObject('  ').value).toEqual({})
    expect(parseJsonObject('{"policy":{"enabled":true}}').value).toEqual({ policy: { enabled: true } })
    expect(parseJsonObject('"just-a-string"').error).toBeTruthy()
    expect(parseJsonObject('"just-a-string"').value).toBeNull()
    const specs = extractTemplateSpecs(
      makeCtx([{ name: 't', fields: { template_id: '  my-audit  ', name: '  My Audit  ', description: '  d  ' } }]).canvas,
    )
    expect(specs[0].templateId).toBe('my-audit')
    expect(specs[0].name).toBe('My Audit')
    expect(specs[0].description).toBe('d')
    expect(templateKey(specs[0])).toBe('my-audit')
  })
})
