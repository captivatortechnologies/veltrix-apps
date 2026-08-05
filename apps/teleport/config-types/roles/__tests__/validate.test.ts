import validate, { extractRoleSpecs, buildRoleYaml } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'roles',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'teleport',
    entityType: 'roles',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_SPEC = 'allow:\n  logins: [ubuntu]\noptions:\n  max_session_ttl: 8h'

describe('Teleport Roles Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal role', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'dev-access', version: 'v7', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { version: 'v7', spec: VALID_SPEC } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an invalid name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'bad name!', version: 'v7', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('warns (does not error) on a built-in preset role name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'access', version: 'v7', spec: VALID_SPEC } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'preset_role')).toBe(true)
  })

  it('rejects a duplicate role name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'dev-access', version: 'v7', spec: VALID_SPEC } },
        { name: 'sec2', fields: { name: 'dev-access', version: 'v7', spec: VALID_SPEC } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_role')).toBe(true)
  })

  it('rejects an invalid version', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'dev-access', version: 'v9', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  it('rejects a missing spec', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'dev-access', version: 'v7' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('spec'))).toBe(true)
  })

  it('rejects a spec that mistakenly includes a full kind/metadata envelope', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'dev-access',
            version: 'v7',
            spec: 'kind: role\nmetadata:\n  name: dev-access\nspec:\n  allow: {}',
          },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unexpected_envelope')).toBe(true)
  })
})

describe('extractRoleSpecs', () => {
  it('trims fields and defaults version to v7 when blank', () => {
    const specs = extractRoleSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: '  dev-access  ', version: '  ', spec: `  ${VALID_SPEC}  ` } }]),
    )
    expect(specs[0].name).toBe('dev-access')
    expect(specs[0].version).toBe('v7')
    expect(specs[0].spec).toBe(VALID_SPEC)
  })
})

describe('buildRoleYaml', () => {
  it('wraps the spec into a full role resource document', () => {
    const yaml = buildRoleYaml({ sectionName: 's', name: 'dev-access', version: 'v7', spec: 'allow:\n  logins: [ubuntu]' })
    expect(yaml).toBe('kind: role\nversion: v7\nmetadata:\n  name: dev-access\nspec:\n  allow:\n    logins: [ubuntu]\n')
  })
})
