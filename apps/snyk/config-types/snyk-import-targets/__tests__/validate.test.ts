import validate, {
  extractImportTargetSpecs,
  targetDisplayName,
  targetKey,
  toRepoTarget,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-import-targets',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-import-targets',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { org_id: 'org-123' },
    platform: stubPlatform,
  }
}

const valid = {
  integration_id: '9a3e5d90-b782-468a-a042-9a2073736f0b',
  scm_type: 'github',
  owner: 'org-security',
  name: 'goof',
  branch: 'main',
}

describe('Snyk Import Targets Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid github target', async () => {
    const result = await validate(makeCtx([{ name: 'T', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires integration id, owner and name', async () => {
    const result = await validate(makeCtx([{ name: 'T', fields: { scm_type: 'github', branch: 'main' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('integration_id'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('owner'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported source type', async () => {
    const result = await validate(makeCtx([{ name: 'T', fields: { ...valid, scm_type: 'gitlab' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_scm_type')).toBe(true)
  })

  it('requires a branch for github but not bitbucket-cloud', async () => {
    const gh = await validate(makeCtx([{ name: 'T', fields: { ...valid, branch: undefined } }]))
    expect(gh.valid).toBe(false)
    expect(gh.errors.some((e) => e.code === 'branch_required')).toBe(true)

    const bb = await validate(
      makeCtx([{ name: 'T', fields: { integration_id: 'i', scm_type: 'bitbucket-cloud', owner: 'ws', name: 'repo' } }]),
    )
    expect(bb.valid).toBe(true)
  })

  it('rejects a duplicate target for the same integration case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...valid } },
        { name: 'b', fields: { ...valid, owner: 'ORG-security', name: 'Goof' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_target')).toBe(true)
  })

  it('allows the same repo through a different integration', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...valid } },
        { name: 'b', fields: { ...valid, integration_id: 'other-integration' } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('helpers behave', () => {
    expect(targetDisplayName(' org ', ' repo ')).toBe('org/repo')
    expect(targetKey('INT', 'Org', 'Repo')).toBe('int::org/repo')

    const spec = extractImportTargetSpecs(
      makeCtx([{ name: 's', fields: { ...valid, exclusion_globs: '  tests, docs  ' } }]).canvas,
    )[0]
    expect(spec.owner).toBe('org-security')
    expect(spec.name).toBe('goof')
    expect(spec.branch).toBe('main')
    expect(spec.exclusionGlobs).toBe('tests, docs')

    expect(toRepoTarget(spec)).toEqual({ owner: 'org-security', name: 'goof', branch: 'main' })

    const noBranch = extractImportTargetSpecs(
      makeCtx([{ name: 's', fields: { integration_id: 'i', scm_type: 'bitbucket-cloud', owner: 'ws', name: 'r' } }]).canvas,
    )[0]
    expect(toRepoTarget(noBranch)).toEqual({ owner: 'ws', name: 'r' })
    expect(noBranch.exclusionGlobs).toBeUndefined()
  })
})
