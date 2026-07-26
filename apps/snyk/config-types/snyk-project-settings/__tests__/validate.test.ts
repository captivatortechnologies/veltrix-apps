import validate, {
  checkInteger,
  extractProjectSettingsSpecs,
  projectKey,
  readBool,
  readNumber,
} from '../validate'
import { managedBody } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-project-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-project-settings',
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

const valid = { project_id: '463c1ee5-31bc-428c-b451-b79a3270db08', pull_request_test_enabled: true }

describe('Snyk Project Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid project', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a project id', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { pull_request_test_enabled: true } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('project_id'))).toBe(true)
  })

  it('rejects a non-positive-integer upgrade limit', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid, auto_dep_upgrade_limit: 'many' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_limit')).toBe(true)
  })

  it('rejects a fractional upgrade limit', async () => {
    const result = await validate(makeCtx([{ name: 'P', fields: { ...valid, auto_dep_upgrade_limit: 2.5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_limit')).toBe(true)
  })

  it('accepts a zero minimum dependency age but rejects a negative one', async () => {
    const ok = await validate(makeCtx([{ name: 'P', fields: { ...valid, auto_dep_upgrade_min_age: 0 } }]))
    expect(ok.valid).toBe(true)
    const bad = await validate(makeCtx([{ name: 'P', fields: { ...valid, auto_dep_upgrade_min_age: -3 } }]))
    expect(bad.valid).toBe(false)
    expect(bad.errors.some((e) => e.code === 'invalid_min_age')).toBe(true)
  })

  it('rejects duplicate project ids case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { project_id: 'ABC-123' } },
        { name: 'b', fields: { project_id: 'abc-123' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_project')).toBe(true)
  })

  it('helpers behave', () => {
    expect(projectKey('  ABC-123 ')).toBe('abc-123')
    expect(readBool('yes', false)).toBe(true)
    expect(readBool('', true)).toBe(false)
    expect(readNumber('7')).toBe(7)
    expect(readNumber('  ')).toBeUndefined()
    expect(checkInteger('', 1)).toBeNull()
    expect(checkInteger(3, 1)).toBeNull()
    expect(checkInteger(0, 1)).toContain('positive')
    expect(checkInteger(0, 0)).toBeNull()
    expect(checkInteger(-1, 0)).toContain('whole number')

    const spec = extractProjectSettingsSpecs(
      makeCtx([
        {
          name: 's',
          fields: {
            project_id: '  p-1  ',
            pull_request_test_enabled: true,
            pull_request_fail_only_high: 'true',
            auto_dep_upgrade_limit: 5,
          },
        },
      ]).canvas,
    )[0]
    expect(spec.projectId).toBe('p-1')
    expect(spec.prTestEnabled).toBe(true)
    expect(spec.prFailOnlyHigh).toBe(true)
    expect(spec.autoDepUpgradeLimit).toBe(5)
    expect(spec.autoDepUpgradeMinAge).toBeUndefined()
  })

  it('managedBody always sends the three booleans and only set numbers', () => {
    const body = managedBody({
      sectionName: 's',
      projectId: 'p-1',
      prTestEnabled: true,
      prFailOnAny: false,
      prFailOnlyHigh: true,
      autoDepUpgradeEnabled: false,
    })
    expect(body.pullRequestTestEnabled).toBe(true)
    expect(body.pullRequestFailOnAnyVulns).toBe(false)
    expect(body.pullRequestFailOnlyForHighSeverity).toBe(true)
    expect(body.autoDepUpgradeEnabled).toBe(false)
    expect('autoDepUpgradeLimit' in body).toBe(false)
    expect('autoDepUpgradeMinAge' in body).toBe(false)
  })
})
