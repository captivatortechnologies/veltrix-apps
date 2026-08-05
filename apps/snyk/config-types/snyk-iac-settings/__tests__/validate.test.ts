import validate, { buildCustomRulesAttributes, extractIacSettings, readBool } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'snyk',
    customerId: 'cust-1',
    configTypeId: 'snyk-iac-settings',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'snyk',
      entityType: 'snyk-iac-settings',
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

describe('Snyk IaC Settings Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates disabled custom rules with no warnings', async () => {
    const result = await validate(makeCtx([{ name: 'IaC', fields: { is_enabled: false } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('validates enabled custom rules with a registry configured', async () => {
    const result = await validate(
      makeCtx([{ name: 'IaC', fields: { is_enabled: true, oci_registry_url: 'https://reg.example.com/bundle' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toHaveLength(0)
  })

  it('warns when enabled with no registry and not inheriting', async () => {
    const result = await validate(makeCtx([{ name: 'IaC', fields: { is_enabled: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'iac_custom_rules_incomplete')).toBe(true)
  })

  it('warns when inheriting from parent but a registry is also set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'IaC',
          fields: { is_enabled: true, inherit_from_parent: true, oci_registry_url: 'https://reg.example.com/bundle' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'iac_inherit_ignores_registry')).toBe(true)
  })

  it('rejects more than one item (singleton)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { is_enabled: true } },
        { name: 'b', fields: { is_enabled: false } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton_only')).toBe(true)
  })

  it('readBool + extract behave', () => {
    expect(readBool(true, false)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(undefined, true)).toBe(true)
    const spec = extractIacSettings(
      makeCtx([{ name: 's', fields: { is_enabled: 'true', oci_registry_url: '  https://x  ', oci_registry_tag: ' latest ' } }])
        .canvas,
    )
    expect(spec.isEnabled).toBe(true)
    expect(spec.ociRegistryUrl).toBe('https://x')
    expect(spec.ociRegistryTag).toBe('latest')
  })

  it('buildCustomRulesAttributes omits registry fields when inheriting from parent', () => {
    const attrs = buildCustomRulesAttributes({
      isEnabled: true,
      inheritFromParent: true,
      ociRegistryUrl: 'https://x',
      ociRegistryTag: 'latest',
    })
    expect(attrs).toEqual({ is_enabled: true, inherit_from_parent: 'group' })
  })

  it('buildCustomRulesAttributes includes registry fields when not inheriting', () => {
    const attrs = buildCustomRulesAttributes({
      isEnabled: true,
      inheritFromParent: false,
      ociRegistryUrl: 'https://x',
      ociRegistryTag: 'latest',
    })
    expect(attrs).toEqual({ is_enabled: true, oci_registry_url: 'https://x', oci_registry_tag: 'latest' })
  })
})
