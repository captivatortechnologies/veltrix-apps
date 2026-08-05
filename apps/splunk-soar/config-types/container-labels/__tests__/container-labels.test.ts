import validate from '../validate'
import { buildLabelName, parseLabelList } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'container-labels',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'container-labels',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Splunk SOAR Container Labels', () => {
  it('validates a well-formed label', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'phishing' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('warns on a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'phishing' } },
        { name: 'sec2', fields: { name: 'phishing' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('buildLabelName trims whitespace', () => {
    expect(buildLabelName({ name: '  events  ' })).toBe('events')
  })

  it('parseLabelList accepts a bare array of strings', () => {
    expect(parseLabelList(['events', 'phishing'])).toEqual(['events', 'phishing'])
  })

  it('parseLabelList accepts a {labels:[...]} wrapper', () => {
    expect(parseLabelList({ labels: ['events'] })).toEqual(['events'])
  })

  it('parseLabelList accepts the generic {data:[...]} envelope', () => {
    expect(parseLabelList({ data: ['events'] })).toEqual(['events'])
  })

  it('parseLabelList returns empty for an unrecognized shape', () => {
    expect(parseLabelList(null)).toEqual([])
    expect(parseLabelList('events')).toEqual([])
  })
})
