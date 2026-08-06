import validate, { extractRotatedSecretSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'rotated-secret-configs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'rotated-secret-configs',
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

describe('Akeyless Rotated Secret Configs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a postgresql rotator with rotatorType target', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'pg-rot', type: 'postgresql', targetName: 'pg-prod', rotatorType: 'target' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects rotatorType "api-key" for a postgresql rotator', async () => {
    const result = await validate(
      makeCtx([{ name: 'r1', fields: { name: 'pg-rot', type: 'postgresql', targetName: 'pg-prod', rotatorType: 'api-key' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rotatorType') && e.code === 'invalid_value')).toBe(true)
  })

  it('accepts rotatorType "api-key" for an aws rotator', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'aws-rot', type: 'aws', targetName: 'aws-prod', rotatorType: 'api-key' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects rotatorType "password" for an aws rotator', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'aws-rot', type: 'aws', targetName: 'aws-prod', rotatorType: 'password' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rotatorType'))).toBe(true)
  })

  it('requires targetName', async () => {
    const result = await validate(makeCtx([{ name: 'r1', fields: { name: 'pg-rot', type: 'postgresql', rotatorType: 'target' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.targetName'))).toBe(true)
  })

  it('rejects an out-of-range rotationInterval when autoRotate is enabled', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r1',
          fields: { name: 'pg-rot', type: 'postgresql', targetName: 'pg-prod', rotatorType: 'target', autoRotate: true, rotationInterval: '400' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.rotationInterval'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'r1', fields: { name: 'dup', type: 'aws', targetName: 't', rotatorType: 'target' } },
        { name: 'r2', fields: { name: 'dup', type: 'aws', targetName: 't', rotatorType: 'target' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractRotatedSecretSpecs', () => {
  it('defaults authenticationCredentials to use-self-creds', () => {
    const specs = extractRotatedSecretSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'rotated-secret-configs',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', type: 'postgresql' } }],
      snapshot: {},
    })
    expect(specs[0].authenticationCredentials).toBe('use-self-creds')
  })
})
