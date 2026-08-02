import validate from '../validate'
import { buildWatchBody, extractWatchSpecs, watchKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'watches',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'watches',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function item(name: string, fields: Record<string, unknown>): CanvasItemSnapshot {
  return { name, fields: { name, ...fields } }
}

const validFields = { security_policy_names: ['block-critical'] }

describe('JFrog Xray Watches — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a valid all-repos watch', async () => {
    const result = await validate(makeCtx([item('watch-all', validFields)]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid single-repository watch', async () => {
    const result = await validate(makeCtx([item('watch-repo', { resource_scope: 'repository', repository_name: 'libs-release-local', ...validFields })]))
    expect(result.valid).toBe(true)
  })

  it('requires a watch name', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { ...validFields } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('rejects a watch name containing a slash', async () => {
    const result = await validate(makeCtx([item('bad/name', validFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NAME')).toBe(true)
  })

  it('rejects duplicate watch names', async () => {
    const result = await validate(makeCtx([item('dup', validFields), item('dup', validFields)]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('requires a repository name when scope is "repository"', async () => {
    const result = await validate(makeCtx([item('watch-repo', { resource_scope: 'repository', ...validFields })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'MISSING_REPOSITORY_NAME')).toBe(true)
  })

  it('rejects an unsupported resource scope', async () => {
    const result = await validate(makeCtx([item('watch-x', { resource_scope: 'all-builds', ...validFields })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SCOPE')).toBe(true)
  })

  it('rejects a malformed watch recipient email', async () => {
    const result = await validate(makeCtx([item('watch-x', { ...validFields, watch_recipients: ['not-an-email'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('warns when no policy is assigned', async () => {
    const result = await validate(makeCtx([item('watch-empty', {})]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'NO_ASSIGNED_POLICIES')).toBe(true)
  })

  it('rejects invalid resources_json', async () => {
    const result = await validate(makeCtx([item('watch-x', { ...validFields, resources_json: '{bad' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_JSON')).toBe(true)
  })

  it('rejects a resources_json entry with no "type"', async () => {
    const result = await validate(makeCtx([item('watch-x', { ...validFields, resources_json: '[{"name":"release-pipeline"}]' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RESOURCE')).toBe(true)
  })

  it('warns (does not error) on an unrecognized resources_json type', async () => {
    const result = await validate(makeCtx([item('watch-x', { ...validFields, resources_json: '[{"type":"futureType","name":"x"}]' })]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNRECOGNIZED_RESOURCE_TYPE')).toBe(true)
  })

  it('accepts a well-formed build resource in resources_json', async () => {
    const result = await validate(makeCtx([item('watch-x', { ...validFields, resources_json: '[{"type":"build","name":"release-pipeline"}]' })]))
    expect(result.valid).toBe(true)
  })
})

describe('JFrog Xray Watches — _shared helpers', () => {
  it('extractWatchSpecs reads and trims canvas fields', () => {
    const specs = extractWatchSpecs(makeCtx([{ name: 'e', fields: { name: '  watch-1  ', active: false, security_policy_names: ['a', 'b'] } }]).canvas)
    expect(specs[0].name).toBe('watch-1')
    expect(specs[0].active).toBe(false)
    expect(specs[0].securityPolicyNames).toEqual(['a', 'b'])
    expect(specs[0].resourceScope).toBe('all-repos')
  })

  it('watchKey trims but preserves case', () => {
    expect(watchKey('  Prod-Watch  ')).toBe('Prod-Watch')
  })

  it('buildWatchBody produces the all-repos scope by default', () => {
    const specs = extractWatchSpecs(makeCtx([item('watch-all', validFields)]).canvas)
    const body = buildWatchBody(specs[0])
    expect(body.general_data.name).toBe('watch-all')
    expect(body.general_data.active).toBe(true)
    expect(body.project_resources.resources).toEqual([{ type: 'all-repos' }])
    expect(body.assigned_policies).toEqual([{ name: 'block-critical', type: 'security' }])
  })

  it('buildWatchBody builds a single-repository scope with bin_mgr_id and filters', () => {
    const specs = extractWatchSpecs(
      makeCtx([
        item('watch-repo', {
          resource_scope: 'repository',
          repository_name: 'libs-release-local',
          bin_mgr_id: 'art-prod-eu',
          package_type_filters: ['Docker'],
          license_policy_names: ['ban-gpl'],
        }),
      ]).canvas,
    )
    const body = buildWatchBody(specs[0])
    expect(body.project_resources.resources).toEqual([
      { type: 'repository', name: 'libs-release-local', bin_mgr_id: 'art-prod-eu', filters: [{ type: 'package-type', value: 'Docker' }] },
    ])
    expect(body.assigned_policies).toEqual([{ name: 'ban-gpl', type: 'license' }])
  })

  it('buildWatchBody appends resources_json entries after the typed scope', () => {
    const specs = extractWatchSpecs(
      makeCtx([item('watch-x', { ...validFields, resources_json: JSON.stringify([{ type: 'build', name: 'release-pipeline' }]) })]).canvas,
    )
    const body = buildWatchBody(specs[0])
    expect(body.project_resources.resources).toHaveLength(2)
    expect(body.project_resources.resources[1]).toEqual({ type: 'build', name: 'release-pipeline' })
  })

  it('buildWatchBody sets watch_recipients and ticket fields when enabled', () => {
    const specs = extractWatchSpecs(
      makeCtx([item('watch-x', { ...validFields, watch_recipients: ['secops@example.com'], create_ticket_enabled: true, ticket_profile: 'JIRA-DEFAULT' })]).canvas,
    )
    const body = buildWatchBody(specs[0])
    expect(body.watch_recipients).toEqual(['secops@example.com'])
    expect(body.create_ticket_enabled).toBe(true)
    expect(body.ticket_profile).toBe('JIRA-DEFAULT')
  })
})
