import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Roles Canvas',
      toolType: 'splunk',
      entityType: 'roles',
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

describe('Splunk Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates valid role configuration', async () => {
    const result = await validate(
      makeCtx([{
        name: 'custom-role',
        fields: { name: 'soc-analyst', capabilities: ['search', 'list_inputs'], importedRoles: ['user'] },
      }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing role name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects invalid role name format', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Invalid Role!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects reserved role names', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'admin' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'reserved_name')).toBe(true)
  })

  it('rejects role name exceeding max length', async () => {
    const longName = 'a' + 'b'.repeat(80)
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: longName } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('detects duplicate role names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'my-role' } },
        { name: 'sec2', fields: { name: 'my-role' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('detects circular import (role importing itself)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-role', importedRoles: ['my-role'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'circular_import')).toBe(true)
  })

  it('warns on long search filter', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-role', srchFilter: 'x'.repeat(2001) } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'long_filter')).toBe(true)
  })

  it('rejects negative disk quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-role', srchDiskQuota: -100 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects negative jobs quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-role', srchJobsQuota: -5 } }]),
    )
    expect(result.valid).toBe(false)
  })

  it('warns on high jobs quota', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'my-role', srchJobsQuota: 150 } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'high_quota')).toBe(true)
  })
})
