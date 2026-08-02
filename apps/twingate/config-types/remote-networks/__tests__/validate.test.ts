import validate from '../validate'
import { extractRemoteNetworkSpecs, networkKey, readBool } from '../_shared'
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
    entityType: 'remote-networks',
    items,
    sections: items,
    snapshot: {},
  }
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'twingate',
    customerId: 'cust-1',
    configTypeId: 'remote-networks',
    canvas: makeCanvas(items),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Twingate Remote Networks validate handler', () => {
  it('returns invalid for an empty canvas', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid network', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { name: 'HQ Network' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported location', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { name: 'HQ', location: 'MARS' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_location')).toBe(true)
  })

  it('rejects an unsupported network type', async () => {
    const result = await validate(makeCtx([{ name: 'item1', fields: { name: 'HQ', network_type: 'SPECIAL' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_network_type')).toBe(true)
  })

  it('rejects duplicate network names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'HQ Network' } },
        { name: 'b', fields: { name: 'hq network' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network')).toBe(true)
  })

  it('extractRemoteNetworkSpecs defaults and trims', () => {
    const specs = extractRemoteNetworkSpecs(makeCanvas([{ name: 'item1', fields: { name: '  HQ  ' } }]))
    expect(specs[0].name).toBe('HQ')
    expect(specs[0].location).toBe('OTHER')
    expect(specs[0].networkType).toBe('REGULAR')
    expect(specs[0].isActive).toBe(true)
    expect(networkKey('  HQ ')).toBe('hq')
  })

  it('readBool behaves as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(false, true)).toBe(false)
  })
})
