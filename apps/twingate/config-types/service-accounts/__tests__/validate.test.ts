import validate from '../validate'
import { extractServiceAccountSpecs, serviceAccountKey } from '../_shared'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(items: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'twingate',
    entityType: 'service-accounts',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'twingate',
    customerId: 'cust-1',
    configTypeId: 'service-accounts',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Twingate Service Accounts validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid service account', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { name: 'ci-runner' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate service account names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'ci-runner' } },
        { name: 'b', fields: { name: 'CI-Runner' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_service_account')).toBe(true)
  })

  it('extractServiceAccountSpecs trims names', () => {
    const specs = extractServiceAccountSpecs(makeCanvas([{ name: 'item1', fields: { name: '  ci-runner  ' } }]))
    expect(specs[0].name).toBe('ci-runner')
    expect(serviceAccountKey('  CI-Runner ')).toBe('ci-runner')
  })
})
