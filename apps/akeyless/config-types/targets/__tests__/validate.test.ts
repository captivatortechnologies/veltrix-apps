import validate, { extractTargetSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'targets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'targets',
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

describe('Akeyless Targets Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal db target', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'pg-prod', type: 'db', dbType: 'postgres' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a db target with no dbType', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'pg-prod', type: 'db' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.dbType'))).toBe(true)
  })

  it('rejects a db target with an invalid dbType', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'pg-prod', type: 'db', dbType: 'db2' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.dbType') && e.code === 'invalid_value')).toBe(true)
  })

  it('requires accessKeyId for aws targets', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'aws-1', type: 'aws' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.accessKeyId'))).toBe(true)
  })

  it('accepts an aws target with accessKeyId', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'aws-1', type: 'aws', accessKeyId: 'AKIAEXAMPLE' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires k8sClusterEndpoint for k8s targets', async () => {
    const result = await validate(makeCtx([{ name: 't1', fields: { name: 'k8s-1', type: 'k8s' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.k8sClusterEndpoint'))).toBe(true)
  })

  it('rejects a duplicate target name', async () => {
    const result = await validate(
      makeCtx([
        { name: 't1', fields: { name: 'dup', type: 'aws', accessKeyId: 'x' } },
        { name: 't2', fields: { name: 'dup', type: 'aws', accessKeyId: 'x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractTargetSpecs', () => {
  it('defaults connectionType and region', () => {
    const specs = extractTargetSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'targets',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'aws-1', type: 'aws' } }],
      snapshot: {},
    })
    expect(specs[0].region).toBe('us-east-2')
  })
})
