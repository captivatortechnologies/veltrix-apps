import validate, { extractLibraryFileSpecs, fileNameKey, MAX_FILE_SIZE_BYTES } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-live-response-library',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-live-response-library',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

describe('Defender Live Response Library Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a well-formed script item', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { file_name: 'collect-triage.ps1', content: 'Get-Process', description: 'Collects process list' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a file name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { content: 'echo hi' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('file_name'))).toBe(true)
  })

  it('rejects a file name with a path separator', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { file_name: 'scripts/collect.ps1', content: 'echo hi' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_file_name')).toBe(true)
  })

  it('requires content', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { file_name: 'collect.ps1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.endsWith('content'))).toBe(true)
  })

  it('rejects content over the 20 MB limit', async () => {
    const oversized = 'a'.repeat(MAX_FILE_SIZE_BYTES + 1)
    const result = await validate(makeCtx([{ name: 'a', fields: { file_name: 'huge.ps1', content: oversized } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'file_too_large')).toBe(true)
  })

  it('warns when parameters are accepted but undescribed', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { file_name: 'run.ps1', content: 'param($x)', has_parameters: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'parameters_description_recommended')).toBe(true)
  })

  it('rejects the same file name declared twice (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { file_name: 'Collect.ps1', content: 'echo 1' } },
        { name: 'b', fields: { file_name: 'collect.PS1', content: 'echo 2' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_file_name')).toBe(true)
  })

  it('extract trims metadata but preserves content verbatim', () => {
    const specs = extractLibraryFileSpecs(
      makeCtx([{ name: 't', fields: { file_name: '  collect.ps1  ', content: '  echo hi  ', has_parameters: 'true' } }]).canvas,
    )
    expect(specs[0].fileName).toBe('collect.ps1')
    expect(specs[0].content).toBe('  echo hi  ')
    expect(specs[0].hasParameters).toBe(true)
  })

  it('fileNameKey normalizes case for identity comparison', () => {
    expect(fileNameKey('Collect.PS1')).toBe(fileNameKey('collect.ps1'))
  })
})
