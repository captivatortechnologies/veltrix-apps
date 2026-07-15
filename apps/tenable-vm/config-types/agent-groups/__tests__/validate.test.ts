import validate, { extractAgentGroupSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'agent-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'agent-groups',
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

describe('Tenable Agent Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid group (scannerId defaults to 1 when blank)', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: { name: 'Linux Servers' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid group with an explicit scanner id', async () => {
    const result = await validate(
      makeCtx([{ name: 'Group', fields: { name: 'Linux Servers', scannerId: '2' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { scannerId: '1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(256) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a non-numeric scanner id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Group A', scannerId: 'abc' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scanner_id')).toBe(true)
  })

  it('rejects a scanner id of zero', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Group A', scannerId: '0' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scanner_id')).toBe(true)
  })

  it('rejects a duplicate (scannerId, name) pair', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Linux Servers', scannerId: '1' } },
        { name: 'sec2', fields: { name: 'Linux Servers', scannerId: '1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_group')).toBe(true)
  })

  it('allows the same name under different scanners', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Linux Servers', scannerId: '1' } },
        { name: 'sec2', fields: { name: 'Linux Servers', scannerId: '2' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractAgentGroupSpecs', () => {
  it('trims the name and defaults a blank scanner id to "1"', () => {
    const specs = extractAgentGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'agent-groups',
      items: [],
      sections: [
        {
          name: 'sec1',
          fields: {
            name: '  Linux Servers  ',
            scannerId: '  ',
          },
        },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('Linux Servers')
    expect(specs[0].scannerId).toBe('1')
  })

  it('trims an explicit scanner id', () => {
    const specs = extractAgentGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'agent-groups',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'Group A', scannerId: '  3  ' } }],
      snapshot: {},
    })
    expect(specs[0].scannerId).toBe('3')
  })
})
