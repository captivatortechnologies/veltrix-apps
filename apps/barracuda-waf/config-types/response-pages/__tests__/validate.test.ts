import validate, { buildResponsePageBody, extractResponsePageSpecs, responsePageKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'response-pages',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'response-pages',
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

const GOOD_FIELDS = {
  name: 'custom-403',
  status_code: '403',
  type: 'Error Pages',
  headers: ['X-Custom-Header: blocked'],
  body: '<html><body>Forbidden</body></html>',
}

describe('Barracuda WAF Response Pages Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete page', async () => {
    const result = await validate(makeCtx([{ name: 'Page', fields: GOOD_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { status_code: '403' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('.name'))).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'page1', status_code: '403' } },
        { name: 'b', fields: { name: 'PAGE1', status_code: '404' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a missing status code', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'page1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('status_code'))).toBe(true)
  })

  it('warns on a non-3-digit status code', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'page1', status_code: 'forbidden' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'status_code_format')).toBe(true)
  })

  it('warns on a header without a colon', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'page1', status_code: '403', headers: ['NotAHeaderLine'] } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'header_format')).toBe(true)
  })

  it('extractResponsePageSpecs defaults type to Error Pages and headers/body to empty', () => {
    const specs = extractResponsePageSpecs(makeCtx([{ name: 's', fields: { name: 'page1', status_code: '403' } }]).canvas)
    expect(specs[0].type).toBe('Error Pages')
    expect(specs[0].headers).toEqual([])
    expect(specs[0].body).toBe('')
  })

  it('responsePageKey lower-cases and trims', () => {
    expect(responsePageKey(' Page1 ')).toBe('page1')
  })

  it('buildResponsePageBody maps the spec onto the wire shape', () => {
    const specs = extractResponsePageSpecs(makeCtx([{ name: 's', fields: GOOD_FIELDS }]).canvas)
    expect(buildResponsePageBody(specs[0])).toEqual({
      name: 'custom-403',
      status_code: '403',
      type: 'Error Pages',
      headers: ['X-Custom-Header: blocked'],
      body: '<html><body>Forbidden</body></html>',
    })
  })
})
