import validate from '../validate'
import { buildStatusRecord, STATUS_TYPES } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'container-statuses',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'container-statuses',
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

function fields(overrides: Record<string, unknown> = {}) {
  return { name: 'triaging', status_type: 'open', is_default: false, ...overrides }
}

describe('Splunk SOAR Container Statuses', () => {
  it('validates a well-formed status', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields() }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an invalid category', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields({ status_type: 'archived' }) }]))
    expect(result.valid).toBe(false)
  })

  it('warns when more than 30 statuses are declared', async () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ name: `s${i}`, fields: fields({ name: `status${i}` }) }))
    const result = await validate(makeCtx(items))
    expect(result.warnings.some((w) => w.code === 'TOO_MANY')).toBe(true)
  })

  it('accepts every documented status_type', () => {
    for (const statusType of STATUS_TYPES) {
      const spec = buildStatusRecord(fields({ status_type: statusType }))
      expect(spec.error).toBeNull()
    }
  })

  it('normalizes status_type case', () => {
    const spec = buildStatusRecord(fields({ status_type: 'OPEN' }))
    expect(spec.error).toBeNull()
    expect(spec.body?.status_type).toBe('open')
  })
})
