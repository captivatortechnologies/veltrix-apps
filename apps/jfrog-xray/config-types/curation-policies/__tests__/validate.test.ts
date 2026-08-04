import validate from '../validate'
import { buildEditablePolicy, extractCurationPolicySpecs, policyKey } from '../_shared'
import type { CanvasItemSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: CanvasItemSnapshot[]): PipelineContext {
  return {
    appId: 'jfrog-xray',
    customerId: 'cust-1',
    configTypeId: 'curation-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jfrog-xray',
      entityType: 'curation-policies',
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
  return { name, fields: { name, condition_id: 'cond-1', ...fields } }
}

describe('JFrog Curation Policies — validate', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed all-repos policy', async () => {
    const result = await validate(makeCtx([item('critical-vulns-only', {})]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { condition_id: 'cond-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_NAME')).toBe(true)
  })

  it('requires a condition id', async () => {
    const result = await validate(makeCtx([{ name: 'x', fields: { name: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_CONDITION_ID')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(makeCtx([item('dup', {}), item('dup', {})]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'DUPLICATE_NAME')).toBe(true)
  })

  it('rejects an invalid scope/policy_action/waiver_request_config', async () => {
    const result = await validate(makeCtx([item('p1', { scope: 'nope', policy_action: 'nope', waiver_request_config: 'nope' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SCOPE')).toBe(true)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY_ACTION')).toBe(true)
    expect(result.errors.some((e) => e.code === 'INVALID_WAIVER_CONFIG')).toBe(true)
  })

  it('requires included repos when scope is specific_repos', async () => {
    const result = await validate(makeCtx([item('p1', { scope: 'specific_repos' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_REPO_INCLUDE')).toBe(true)
  })

  it('requires included package types when scope is pkg_types', async () => {
    const result = await validate(makeCtx([item('p1', { scope: 'pkg_types' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'EMPTY_PKG_TYPES')).toBe(true)
  })

  it('accepts a specific_repos scope with repos included', async () => {
    const result = await validate(makeCtx([item('p1', { scope: 'specific_repos', repo_include: ['npm-remote'] })]))
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed notify email', async () => {
    const result = await validate(makeCtx([item('p1', { notify_emails: ['not-an-email'] })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_EMAIL')).toBe(true)
  })

  it('rejects invalid waivers_json / label_waivers_json', async () => {
    const result = await validate(makeCtx([item('p1', { waivers_json: '{bad', label_waivers_json: '{bad' })]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'INVALID_JSON')).toHaveLength(2)
  })

  it('rejects a waiver missing required fields', async () => {
    const result = await validate(makeCtx([item('p1', { waivers_json: JSON.stringify([{ pkg_type: 'npm' }]) })]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_WAIVER')).toBe(true)
  })

  it('accepts a well-formed waiver and label waiver', async () => {
    const result = await validate(
      makeCtx([
        item('p1', {
          waivers_json: JSON.stringify([{ pkg_type: 'npm', pkg_name: 'lodash', all_versions: true, justification: 'Reviewed' }]),
          label_waivers_json: JSON.stringify([{ label: 'internal-approved', justification: 'Pre-vetted' }]),
        }),
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('JFrog Curation Policies — _shared helpers', () => {
  it('extractCurationPolicySpecs reads and trims canvas fields', () => {
    const specs = extractCurationPolicySpecs(makeCtx([{ name: 'e', fields: { name: '  critical-vulns-only  ', condition_id: '  cond-1  ' } }]).canvas)
    expect(specs[0].name).toBe('critical-vulns-only')
    expect(specs[0].conditionId).toBe('cond-1')
    expect(specs[0].policyAction).toBe('dry_run')
    expect(specs[0].scope).toBe('all_repos')
  })

  it('policyKey trims but preserves case', () => {
    expect(policyKey('  Critical-Vulns-Only  ')).toBe('Critical-Vulns-Only')
  })

  it('buildEditablePolicy produces the create/update payload shape (all_repos scope)', () => {
    const specs = extractCurationPolicySpecs(makeCtx([item('block-critical', { policy_action: 'block', notify_emails: ['secops@example.com'] })]).canvas)
    const body = buildEditablePolicy(specs[0])
    expect(body.name).toBe('block-critical')
    expect(body.condition_id).toBe('cond-1')
    expect(body.scope).toBe('all_repos')
    expect(body.policy_action).toBe('block')
    expect(body.notify_emails).toEqual(['secops@example.com'])
    expect(body.repo_include).toBeUndefined()
  })

  it('buildEditablePolicy includes repo_include only for specific_repos scope', () => {
    const specs = extractCurationPolicySpecs(makeCtx([item('p1', { scope: 'specific_repos', repo_include: ['npm-remote'], repo_exclude: ['ignored'] })]).canvas)
    const body = buildEditablePolicy(specs[0])
    expect(body.repo_include).toEqual(['npm-remote'])
    expect(body.repo_exclude).toBeUndefined()
  })

  it('buildEditablePolicy includes decision_owners only when waiver_request_config is manual', () => {
    const specs = extractCurationPolicySpecs(makeCtx([item('p1', { waiver_request_config: 'manual', decision_owners: ['secops-leads'] })]).canvas)
    const body = buildEditablePolicy(specs[0])
    expect(body.decision_owners).toEqual(['secops-leads'])
  })

  it('buildEditablePolicy includes parsed waivers and label_waivers', () => {
    const specs = extractCurationPolicySpecs(
      makeCtx([
        item('p1', {
          waivers_json: JSON.stringify([{ pkg_type: 'npm', pkg_name: 'lodash', all_versions: true, justification: 'Reviewed' }]),
          label_waivers_json: JSON.stringify([{ label: 'internal-approved', justification: 'Pre-vetted' }]),
        }),
      ]).canvas,
    )
    const body = buildEditablePolicy(specs[0])
    expect(body.waivers).toEqual([{ pkg_type: 'npm', pkg_name: 'lodash', all_versions: true, justification: 'Reviewed' }])
    expect(body.label_waivers).toEqual([{ label: 'internal-approved', justification: 'Pre-vetted' }])
  })

  it('buildEditablePolicy drops a waiver missing required fields rather than sending it malformed', () => {
    const specs = extractCurationPolicySpecs(makeCtx([item('p1', { waivers_json: JSON.stringify([{ pkg_type: 'npm' }]) })]).canvas)
    const body = buildEditablePolicy(specs[0])
    expect(body.waivers).toBeUndefined()
  })
})
