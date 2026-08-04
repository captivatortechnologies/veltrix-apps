import validate, { extractFieldSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-incident-fields',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-incident-fields',
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

describe('Cortex XSOAR Incident Fields Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid field', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { cliName: 'sourceip', name: 'Source IP', type: 'shortText' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing cliName', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No CLI name' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('cliName'))).toBe(true)
  })

  it('rejects a cliName with uppercase or symbols', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { cliName: 'Source_IP', name: 'Bad', type: 'shortText' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cli_name')).toBe(true)
  })

  it('rejects a reserved cliName', async () => {
    const result = await validate(makeCtx([{ name: 's1', fields: { cliName: 'name', name: 'Bad', type: 'shortText' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_cli_name')).toBe(true)
  })

  it('rejects a duplicate cliName', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { cliName: 'sourceip', name: 'A', type: 'shortText' } },
        { name: 'b', fields: { cliName: 'sourceip', name: 'B', type: 'shortText' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_field')).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(
      makeCtx([{ name: 's1', fields: { cliName: 'sourceip', name: 'A', type: 'bogus' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('warns when not associated to all incident types and none declared', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 's1',
          fields: { cliName: 'sourceip', name: 'A', type: 'shortText', associatedToAll: false },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_associated_types')).toBe(true)
  })

  it('extractFieldSpecs lowercases cliName and defaults associatedToAll to true', () => {
    const specs = extractFieldSpecs(makeCtx([{ name: 's', fields: { cliName: 'SourceIP' } }]).canvas)
    expect(specs[0].cliName).toBe('sourceip')
    expect(specs[0].associatedToAll).toBe(true)
  })
})
