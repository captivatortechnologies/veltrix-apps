import validate, {
  extractFileBlockingSpecs,
  buildFileBlockingFields,
  fileBlockingDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-file-blocking-profiles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-file-blocking-profiles',
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

describe('Panorama File Blocking Profiles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal profile', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'block-exe' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', action: 'quarantine' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects an unsupported direction', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', direction: 'sideways' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_direction')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'fb1' } },
        { name: 'b', fields: { name: 'FB1' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds a rule with defaulted applications/file-types and a plain-string action', () => {
    const spec = extractFileBlockingSpecs(makeCtx([{ name: 'r', fields: { name: 'x', file_types: ['exe', '7z'] } }]).canvas)[0]
    const fields = buildFileBlockingFields(spec) as { rules: { entry: Array<Record<string, unknown>> } }
    const rule = fields.rules.entry[0]
    expect(rule.applications).toEqual({ member: ['any'] })
    expect(rule['file-types']).toEqual({ member: ['exe', '7z'] })
    expect(rule.action).toBe('block')
    expect(rule.direction).toBe('both')
  })

  it('detects action and direction drift', () => {
    const spec = extractFileBlockingSpecs(makeCtx([{ name: 'r', fields: { name: 'x' } }]).canvas)[0]
    const clean = fileBlockingDriftDiffs(spec, {
      '@name': 'x',
      rules: { entry: [{ '@name': 'block-executables', applications: { member: ['any'] }, 'file-types': { member: ['any'] }, direction: 'both', action: 'block' }] },
    })
    expect(clean).toHaveLength(0)
    const drifted = fileBlockingDriftDiffs(spec, {
      '@name': 'x',
      rules: { entry: [{ '@name': 'block-executables', action: 'alert', direction: 'upload' }] },
    })
    expect(drifted.some((d) => d.field.endsWith('.action'))).toBe(true)
    expect(drifted.some((d) => d.field.endsWith('.direction'))).toBe(true)
  })
})
