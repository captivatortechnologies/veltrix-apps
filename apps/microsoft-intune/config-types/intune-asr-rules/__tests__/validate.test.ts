import validate, { extractAsrSpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildAsrPolicyBody, parseLiveRuleStates } from '../../../lib/asr'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-asr-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-asr-rules',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000', azure_cloud: 'commercial' },
    platform: stubPlatform,
  }
}

describe('Intune ASR Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a policy with at least one configured rule', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'Baseline', block_email_executable: 'block', block_office_child_process: 'audit' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { block_email_executable: 'block' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a policy with no configured rules', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'Empty', block_email_executable: 'notconfigured' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_rules_configured')).toBe(true)
  })

  it('rejects duplicate policy names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { policy_name: 'Baseline', block_email_executable: 'block' } },
        { name: 'b', fields: { policy_name: 'BASELINE', block_office_child_process: 'block' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('extract reads rule states + exclusions', () => {
    const specs = extractAsrSpecs(
      makeCtx([{ name: 'p', fields: { policy_name: '  Baseline  ', block_email_executable: 'block', exclusions: 'C:\\a.exe, C:\\b.exe' } }]).canvas,
    )
    expect(specs[0].name).toBe('Baseline')
    expect(specs[0].rules.block_email_executable).toBe('block')
    expect(specs[0].rules.block_office_child_process).toBe('notconfigured')
    expect(specs[0].exclusions).toEqual(['C:\\a.exe', 'C:\\b.exe'])
    expect(policyKey('  Baseline ')).toBe('baseline')
  })

  it('builds a Graph body that round-trips through parseLiveRuleStates', () => {
    const specs = extractAsrSpecs(
      makeCtx([{ name: 'p', fields: { policy_name: 'Baseline', block_email_executable: 'block', block_obfuscated_scripts: 'audit', block_lsass_credential_theft: 'warn' } }]).canvas,
    )
    const body = buildAsrPolicyBody(specs[0]) as { name: string; technologies: string; settings: unknown[] }
    expect(body.name).toBe('Baseline')
    expect(body.technologies).toBe('mdm,microsoftSense')
    // Feed the built settings back through the live-parser (drift path).
    const states = parseLiveRuleStates({ settings: body.settings })
    expect(states.block_email_executable).toBe('block')
    expect(states.block_obfuscated_scripts).toBe('audit')
    expect(states.block_lsass_credential_theft).toBe('warn')
    expect(states.block_office_child_process).toBeUndefined()
  })
})
