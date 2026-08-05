import validate, { extractGithubConnectorSpecs, buildGithubConnectorYaml } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'github-connectors',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'github-connectors',
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
    entityType: 'github-connectors',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_SPEC = 'client_id: abc123\nclient_secret: shh\nteams_to_logins: []'

describe('Teleport GitHub Connectors Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal connector', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'github-sso', version: 'v3', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate connector name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'github-sso', version: 'v3', spec: VALID_SPEC } },
        { name: 'sec2', fields: { name: 'github-sso', version: 'v3', spec: VALID_SPEC } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_connector')).toBe(true)
  })

  it('rejects an unexpected version', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'github-sso', version: 'v99', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  it('warns when client_id is missing from the spec', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'github-sso', version: 'v3', spec: 'client_secret: shh' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'missing_client_id')).toBe(true)
  })

  it('warns when client_secret is missing from the spec', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'github-sso', version: 'v3', spec: 'client_id: abc' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'missing_client_secret')).toBe(true)
  })

  it('rejects a spec containing a full kind/metadata envelope', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'github-sso', version: 'v3', spec: 'kind: github\nmetadata:\n  name: x\nspec:\n  client_id: a' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unexpected_envelope')).toBe(true)
  })
})

describe('extractGithubConnectorSpecs', () => {
  it('defaults version to v3 when blank', () => {
    const specs = extractGithubConnectorSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'github-sso', version: '', spec: VALID_SPEC } }]),
    )
    expect(specs[0].version).toBe('v3')
  })
})

describe('buildGithubConnectorYaml', () => {
  it('wraps the spec into a full github connector resource document', () => {
    const yaml = buildGithubConnectorYaml({ sectionName: 's', name: 'github-sso', version: 'v3', spec: 'client_id: abc' })
    expect(yaml).toBe('kind: github\nversion: v3\nmetadata:\n  name: github-sso\nspec:\n  client_id: abc\n')
  })
})
