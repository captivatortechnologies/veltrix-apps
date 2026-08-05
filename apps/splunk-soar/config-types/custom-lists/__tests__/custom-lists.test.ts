import validate from '../validate'
import { buildListSpec, parseFormattedContent } from '../_shared'
import { parseCsvRows, formatCsvRows } from '../../../lib/soarCommon'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'custom-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'custom-lists',
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

describe('Splunk SOAR Custom Lists', () => {
  it('validates a well-formed list', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'blocklist', content: '1.1.1.1\n2.2.2.2' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an empty content', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'blocklist', content: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CONTENT')).toBe(true)
  })

  it('buildListSpec parses multi-column rows', () => {
    const spec = buildListSpec({ name: 'x', content: '1.1.1.1,US\n2.2.2.2,DE' })
    expect(spec.content).toEqual([
      ['1.1.1.1', 'US'],
      ['2.2.2.2', 'DE'],
    ])
  })

  it('parseCsvRows handles quoted cells containing commas', () => {
    expect(parseCsvRows('"a,b",c')).toEqual([['a,b', 'c']])
  })

  it('parseCsvRows skips blank lines', () => {
    expect(parseCsvRows('a\n\nb')).toEqual([['a'], ['b']])
  })

  it('formatCsvRows quotes a cell containing a comma', () => {
    expect(formatCsvRows([['a,b', 'c']])).toBe('"a,b",c')
  })

  it('parseFormattedContent accepts a bare 2D array', () => {
    expect(parseFormattedContent([['1.1.1.1'], ['2.2.2.2']])).toEqual([['1.1.1.1'], ['2.2.2.2']])
  })

  it('parseFormattedContent accepts a {content:[...]} wrapper', () => {
    expect(parseFormattedContent({ content: [['1.1.1.1']] })).toEqual([['1.1.1.1']])
  })

  it('buildListSpec skips a blank name without erroring', () => {
    const spec = buildListSpec({ name: '', content: '1.1.1.1' })
    expect(spec.id).toBe('')
    expect(spec.error).toBeNull()
  })
})
