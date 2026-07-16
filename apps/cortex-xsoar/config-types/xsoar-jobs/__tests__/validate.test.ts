import validate, { extractJobSpecs, DEFAULT_JOB_TYPE } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-jobs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-jobs',
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

describe('Cortex XSOAR Jobs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid one-time job', async () => {
    const result = await validate(makeCtx([{ name: 'J1', fields: { name: 'Nightly', playbookId: 'pb-1' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid recurring job with cron', async () => {
    const result = await validate(
      makeCtx([{ name: 'J1', fields: { name: 'Nightly', playbookId: 'pb-1', recurrent: true, cron: '0 9 * * *' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { playbookId: 'pb-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a duplicate job name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Nightly' } },
        { name: 'b', fields: { name: 'Nightly' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_job')).toBe(true)
  })

  it('requires cron for a recurring job', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Nightly', recurrent: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'cron_required')).toBe(true)
  })

  it('rejects a malformed cron expression', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Nightly', recurrent: true, cron: 'daily' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cron')).toBe(true)
  })

  it('warns when a job declares no playbook', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'Nightly' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_playbook')).toBe(true)
  })

  it('extractJobSpecs trims the name and defaults type to Unclassified', () => {
    const specs = extractJobSpecs(makeCtx([{ name: 's', fields: { name: '  Nightly  ' } }]).canvas)
    expect(specs[0].name).toBe('Nightly')
    expect(specs[0].type).toBe(DEFAULT_JOB_TYPE)
    expect(specs[0].recurrent).toBe(false)
  })
})
