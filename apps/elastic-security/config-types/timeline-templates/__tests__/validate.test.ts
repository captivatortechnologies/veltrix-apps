import validate, { definitionOf, extractTemplateSpecs, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'elastic-security',
    customerId: 'cust-1',
    configTypeId: 'timeline-templates',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'elastic-security',
      entityType: 'timeline-templates',
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

describe('Elastic Security Timeline Templates Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal template', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Template',
          fields: { templateTimelineId: '6ce1b592-84e3-4b4a-9552-f189d4b82075', title: 'Phishing investigation' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-specified template', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Template',
          fields: {
            templateTimelineId: 'id-1',
            title: 'Malware containment',
            description: 'Standard containment runbook',
            definitionJson: '{"columns":[{"columnHeaderType":"not-filtered","id":"@timestamp"}]}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing templateTimelineId', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { title: 'X' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('templateTimelineId'))).toBe(true)
  })

  it('rejects a missing title', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { templateTimelineId: 'id-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('title'))).toBe(true)
  })

  it('rejects invalid definitionJson', async () => {
    const result = await validate(
      makeCtx([{ name: 't1', fields: { templateTimelineId: 'id-1', title: 'X', definitionJson: 'not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_definition')).toBe(true)
  })

  it('rejects a duplicate templateTimelineId', async () => {
    const result = await validate(
      makeCtx([
        { name: 't1', fields: { templateTimelineId: 'dup', title: 'A' } },
        { name: 't2', fields: { templateTimelineId: 'dup', title: 'B' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_template')).toBe(true)
  })
})

describe('extractTemplateSpecs', () => {
  it('trims fields', () => {
    const specs = extractTemplateSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'elastic-security',
      entityType: 'timeline-templates',
      items: [],
      sections: [{ name: 'sec1', fields: { templateTimelineId: '  id-1  ', title: '  Title  ' } }],
      snapshot: {},
    })
    expect(specs[0].templateTimelineId).toBe('id-1')
    expect(specs[0].title).toBe('Title')
  })
})

describe('definitionOf / parseJsonObject', () => {
  it('projects a live timeline down to its definition keys', () => {
    expect(
      definitionOf({ title: 'X', description: 'Y', savedObjectId: 'so-1', columns: [{ id: '@timestamp' }], kqlMode: 'filter' }),
    ).toEqual({ columns: [{ id: '@timestamp' }], kqlMode: 'filter' })
  })
  it('parseJsonObject accepts objects only', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonObject('[1]')).toBeNull()
  })
})
