import validate from '../validate'
import { buildCefRecord } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'custom-fields',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'custom-fields',
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

describe('Splunk SOAR Custom Fields (CEF)', () => {
  it('validates a well-formed field', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'sourceHostName', data_type: ['host name'] } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a field with no data types', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'sourceHostName', data_type: [] } }]))
    expect(result.valid).toBe(false)
  })

  it('buildCefRecord accepts a comma-separated string as data_type', () => {
    const spec = buildCefRecord({ name: 'x', data_type: 'ip, domain' })
    expect(spec.error).toBeNull()
    expect(spec.body).toEqual({ name: 'x', data_type: ['ip', 'domain'] })
  })

  it('buildCefRecord skips a blank name without erroring', () => {
    const spec = buildCefRecord({ name: '', data_type: ['ip'] })
    expect(spec.id).toBe('')
    expect(spec.error).toBeNull()
  })
})
