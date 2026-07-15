import validate, { extractNetworkServiceSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-network-services',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-network-services',
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

describe('ZIA Network Services Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a service with a TCP port and a UDP range', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Network Service',
          fields: { name: 'Corp HTTPS', description: 'Corp web', tcp_ports: '443', udp_ports: '5000-5100' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { tcp_ports: '80' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Web', tcp_ports: '80' } },
        { name: 'b', fields: { name: 'web', tcp_ports: '443' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_network_service')).toBe(true)
  })

  it('rejects a service with no TCP or UDP ports', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Empty' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'ports_required')).toBe(true)
  })

  it('rejects invalid and out-of-range port lines', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad', tcp_ports: 'abc\n70000\n90-80' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'invalid_port')).toHaveLength(3)
  })

  it('extractNetworkServiceSpecs parses single ports and ranges', () => {
    const specs = extractNetworkServiceSpecs(
      makeCtx([
        { name: 'Network Service', fields: { name: '  Mixed  ', tcp_ports: '80\n8000-8100', udp_ports: '53' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Mixed')
    expect(specs[0].tcpPorts).toEqual([
      { start: 80, end: 80 },
      { start: 8000, end: 8100 },
    ])
    expect(specs[0].udpPorts).toEqual([{ start: 53, end: 53 }])
  })
})
