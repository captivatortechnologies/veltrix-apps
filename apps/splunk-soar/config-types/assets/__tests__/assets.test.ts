import validate from '../validate'
import { buildAssetSpec } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-soar',
    customerId: 'cust-1',
    configTypeId: 'assets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'splunk-soar',
      entityType: 'assets',
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
  return { name: 'my-vt-asset', product_vendor: 'VirusTotal', product_name: 'VirusTotal Public API', ...overrides }
}

describe('Splunk SOAR Assets', () => {
  it('validates a well-formed asset (with a warning for empty configuration)', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields() }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_CONFIGURATION')).toBe(true)
  })

  it('rejects a missing product_vendor/product_name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: fields({ product_vendor: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID')).toBe(true)
  })

  it('buildAssetSpec never puts configuration into nonSecretBody', () => {
    const spec = buildAssetSpec(fields({ configuration: { api_key: 'super-secret' } }))
    expect((spec.nonSecretBody as Record<string, unknown> | null)?.configuration).toBeUndefined()
    expect(spec.configuration).toEqual({ api_key: 'super-secret' })
  })

  it('buildAssetSpec merges polling fields into configuration.ingest', () => {
    const spec = buildAssetSpec(fields({ poll_enabled: true, poll_interval_mins: 30, poll_container_label: 'events' }))
    expect(spec.configuration.ingest).toEqual({ poll: true, container_label: 'events', interval_mins: 30 })
  })

  it('buildAssetSpec omits ingest entirely when polling is not configured', () => {
    const spec = buildAssetSpec(fields())
    expect(spec.configuration.ingest).toBeUndefined()
  })

  it('buildAssetSpec parses tags/tenants/owners as arrays', () => {
    const spec = buildAssetSpec(fields({ tags: 'a, b', tenants: '1, 2', primary_owners: '5' }))
    expect(spec.nonSecretBody?.tags).toEqual(['a', 'b'])
    expect(spec.nonSecretBody?.tenants).toEqual([1, 2])
    expect(spec.nonSecretBody?.primary_owners).toEqual([5])
  })

  it('buildAssetSpec skips a blank name without erroring', () => {
    const spec = buildAssetSpec({})
    expect(spec.id).toBe('')
    expect(spec.error).toBeNull()
  })
})
