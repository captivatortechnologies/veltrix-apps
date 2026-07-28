import validate, {
  extractSourceControlSpecs,
  sourceControlKey,
  buildRepositoryAccess,
  buildSourceControlBody,
  pickNonSecretProperties,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-sentinel',
    customerId: 'cust-1',
    configTypeId: 'sentinel-source-controls',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-sentinel',
      entityType: 'sentinel-source-controls',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {
      tenant_id: '00000000-0000-0000-0000-000000000000',
      subscription_id: '11111111-1111-1111-1111-111111111111',
      resource_group: 'rg-soc',
      workspace_name: 'ws-sentinel',
      azure_cloud: 'commercial',
    },
    platform: stubPlatform,
  }
}

const validPat = {
  display_name: 'SOC Content Repo',
  description: 'Detections as code',
  repo_type: 'Github',
  repo_url: 'https://github.com/org/sentinel-content',
  repo_branch: 'main',
  content_types: ['AnalyticsRule', 'HuntingQuery'],
  access_kind: 'PAT',
  access_token: 'ghp_secret_pat_value',
  version: 'V2',
}

const validOauthAdo = {
  display_name: 'ADO Pipeline Repo',
  repo_type: 'AzureDevOps',
  repo_url: 'https://dev.azure.com/org/project/_git/repo',
  repo_branch: 'main',
  content_types: ['Workbook'],
  access_kind: 'OAuth',
  access_token: 'oauth-code-abc',
  version: 'V2',
}

describe('Sentinel Source Controls Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete PAT source control', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a complete OAuth Azure DevOps source control', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validOauthAdo } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires display name, repo url and branch', async () => {
    const result = await validate(
      makeCtx([{ name: 'c', fields: { ...validPat, display_name: '', repo_url: '', repo_branch: '' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.display_name') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.repo_url') && e.code === 'required')).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.repo_branch') && e.code === 'required')).toBe(true)
  })

  it('rejects a non-http repository url', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, repo_url: 'git@github.com:org/repo.git' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_repo_url')).toBe(true)
  })

  it('rejects an unsupported repository type', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, repo_type: 'GitLab' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_repo_type')).toBe(true)
  })

  it('requires at least one content type', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, content_types: [] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_content_type')).toBe(true)
  })

  it('rejects an invalid content type', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, content_types: ['AnalyticsRule', 'Bogus'] } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_content_type')).toBe(true)
  })

  it('rejects an invalid access kind', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, access_kind: 'SSH' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_access_kind')).toBe(true)
  })

  it('rejects an invalid version', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, version: 'V3' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })

  it('rejects App access kind on Azure DevOps (GitHub only)', async () => {
    const result = await validate(
      makeCtx([{ name: 'c', fields: { ...validOauthAdo, access_kind: 'App', access_token: '123' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'access_kind_repo_mismatch')).toBe(true)
  })

  it('warns (not errors) on a blank repository credential', async () => {
    const result = await validate(makeCtx([{ name: 'c', fields: { ...validPat, access_token: '' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_credential')).toBe(true)
  })

  it('rejects duplicate display names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validPat, display_name: 'SOC Content Repo' } },
        { name: 'b', fields: { ...validPat, display_name: 'soc content repo' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_source_control')).toBe(true)
  })

  it('extracts content types, defaults and the reconciliation key', () => {
    const specs = extractSourceControlSpecs(makeCtx([{ name: 'c', fields: { ...validPat } }]).canvas)
    expect(specs[0].contentTypes).toEqual(['AnalyticsRule', 'HuntingQuery'])
    expect(specs[0].repoType).toBe('Github')
    expect(specs[0].version).toBe('V2')
    expect(sourceControlKey('SOC Content Repo')).toBe('soc content repo')

    // Missing repo_type / version / access_kind fall back to defaults.
    const bare = extractSourceControlSpecs(
      makeCtx([{ name: 'c', fields: { display_name: 'x', repo_url: 'https://github.com/o/r', repo_branch: 'main', content_types: 'Playbook,Parser' } }]).canvas,
    )
    expect(bare[0].repoType).toBe('Github')
    expect(bare[0].version).toBe('V2')
    expect(bare[0].accessKind).toBe('PAT')
    expect(bare[0].contentTypes).toEqual(['Playbook', 'Parser'])
  })

  it('maps the single secret to the field each access kind requires', () => {
    expect(buildRepositoryAccess('PAT', 'tok')).toEqual({ kind: 'PAT', token: 'tok' })
    expect(buildRepositoryAccess('OAuth', 'code')).toEqual({ kind: 'OAuth', code: 'code' })
    expect(buildRepositoryAccess('App', '42')).toEqual({ kind: 'App', installationId: '42' })
    expect(buildRepositoryAccess('PAT', '')).toBe(undefined)
  })

  it('builds a properties-nested body carrying repositoryAccess only when a secret is supplied', () => {
    const spec = extractSourceControlSpecs(makeCtx([{ name: 'c', fields: { ...validPat } }]).canvas)[0]
    const body = buildSourceControlBody(spec) as {
      properties: {
        displayName: string
        repoType: string
        contentTypes: string[]
        repository: { url: string; branch: string }
        version: string
        repositoryAccess?: { kind: string; token?: string }
      }
    }
    expect(body.properties.displayName).toBe('SOC Content Repo')
    expect(body.properties.repoType).toBe('Github')
    expect(body.properties.repository.url).toBe('https://github.com/org/sentinel-content')
    expect(body.properties.repository.branch).toBe('main')
    expect(body.properties.contentTypes).toEqual(['AnalyticsRule', 'HuntingQuery'])
    expect(body.properties.repositoryAccess).toEqual({ kind: 'PAT', token: 'ghp_secret_pat_value' })

    // Blank credential → repositoryAccess is omitted (keep-existing on update).
    const noSecret = extractSourceControlSpecs(makeCtx([{ name: 'c', fields: { ...validPat, access_token: '' } }]).canvas)[0]
    const body2 = buildSourceControlBody(noSecret) as { properties: { repositoryAccess?: unknown } }
    expect(body2.properties.repositoryAccess).toBe(undefined)
  })

  it('pickNonSecretProperties keeps non-secret fields and can never carry a credential', () => {
    const prior = pickNonSecretProperties({
      displayName: 'SOC Content Repo',
      description: 'd',
      repoType: 'Github',
      contentTypes: ['AnalyticsRule'],
      repository: { url: 'https://github.com/o/r', branch: 'main', displayUrl: 'https://github.com/o/r' },
      version: 'V2',
      // Even if the service ever leaked a credential, the whitelist drops it.
      repositoryAccess: { kind: 'PAT', token: 'should-not-survive' },
    })
    expect(prior.displayName).toBe('SOC Content Repo')
    expect(prior.repository.branch).toBe('main')
    expect(prior.contentTypes).toEqual(['AnalyticsRule'])
    expect(JSON.stringify(prior).includes('should-not-survive')).toBe(false)
    expect((prior as unknown as Record<string, unknown>).repositoryAccess).toBe(undefined)
  })
})
