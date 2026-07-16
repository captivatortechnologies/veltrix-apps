import validate, { extractPolicySpecs, policyKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'
import { buildPolicyBody, parsePolicyJson, stableSettingsHash } from '../../../lib/policy'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'microsoft-intune',
    customerId: 'cust-1',
    configTypeId: 'intune-security-policy',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'microsoft-intune',
      entityType: 'intune-security-policy',
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

const AV_JSON = JSON.stringify({
  name: 'Exported AV',
  description: 'from intune',
  platforms: 'windows10',
  technologies: 'mdm,microsoftSense',
  templateReference: { templateFamily: 'endpointSecurityAntivirus', templateId: 'abc_1' },
  settings: [{ settingInstance: { settingDefinitionId: 'device_vendor_msft_defender_x', choiceSettingValue: { value: 'y' } } }],
})

describe('Intune Endpoint Security Policy Import Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates an imported AV policy', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'Corp AV', policy_json: AV_JSON } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('requires a policy name', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_json: AV_JSON } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'x', policy_json: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects JSON without a settings array', async () => {
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'x', policy_json: '{"templateReference":{}}' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns on a non-endpoint-security family', async () => {
    const other = JSON.stringify({ templateReference: { templateFamily: 'deviceConfigurationScripts' }, settings: [] })
    const result = await validate(makeCtx([{ name: 'p', fields: { policy_name: 'x', policy_json: other } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'non_endpoint_security_family')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { policy_name: 'AV', policy_json: AV_JSON } },
        { name: 'b', fields: { policy_name: 'av', policy_json: AV_JSON } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('extract + body builder behave', () => {
    const specs = extractPolicySpecs(makeCtx([{ name: 'p', fields: { policy_name: '  Corp AV  ', policy_json: AV_JSON } }]).canvas)
    expect(specs[0].name).toBe('Corp AV')
    expect(policyKey(' Corp AV ')).toBe('corp av')
    const parsed = parsePolicyJson(specs[0].policyJsonRaw)
    expect(parsed.error).toBeNull()
    const body = buildPolicyBody('Renamed', 'desc', parsed.value!) as { name: string; settings: unknown[] }
    expect(body.name).toBe('Renamed') // canvas name overrides imported name
    expect(stableSettingsHash(body.settings)).toBe(stableSettingsHash(parsed.value!.settings))
  })
})
