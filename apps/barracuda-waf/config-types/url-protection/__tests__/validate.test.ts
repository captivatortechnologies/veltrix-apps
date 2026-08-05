import validate, { extractUrlProtectionSpec, buildUrlProtectionBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'url-protection',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'url-protection',
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

describe('Barracuda WAF URL Protection Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('rejects more than one declared item (singleton)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: {} }, { name: 'b', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('validates a full, well-formed configuration', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'URL Protection',
          fields: {
            enabled: false,
            allowed_methods: ['GET', 'POST'],
            allowed_content_types: ['application/json'],
            max_content_length: 32768,
            max_parameters: 40,
            maximum_upload_files: 5,
            csrf_prevention: 'Forms',
            maximum_parameter_name_length: 64,
            allow_tilde_in_url: false,
            allow_slash_dot_in_url: false,
            exception_patterns: ['^/health$'],
            sql_injection: 'normal',
            os_command_injection: 'normal',
            cross_site_scripting: 'normal',
            remote_file_inclusion: 'none',
            ldap_injection: 'normal',
            python_php_attacks: 'normal',
            http_specific_injection: 'normal',
            apache_struts_attacks: 'normal',
            directory_traversal: 'none',
            custom_blocked_attack_type_groups: [],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects an invalid csrf_prevention mode', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { csrf_prevention: 'Sometimes' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_csrf_mode')).toBe(true)
  })

  it('rejects a non-positive max content length', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { max_content_length: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_content_length')).toBe(true)
  })

  it('rejects a non-positive max parameters', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { max_parameters: -5 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_parameters')).toBe(true)
  })

  it('extractUrlProtectionSpec applies the documented field defaults', () => {
    const spec = extractUrlProtectionSpec(makeCtx([{ name: 's', fields: {} }]).canvas)
    expect(spec.enabled).toBe(false)
    expect(spec.csrfPrevention).toBe('Forms')
    expect(spec.maxContentLength).toBe(32768)
    expect(spec.maxParameters).toBe(40)
    expect(spec.maximumUploadFiles).toBe(5)
    expect(spec.maximumParameterNameLength).toBe(64)
    expect(spec.allowedMethods).toEqual([])
    expect(spec.attackTypes.directoryTraversal).toBe('none')
  })

  it('buildUrlProtectionBody maps the spec — including the attack-type sub-shape — onto the wire shape', () => {
    const spec = extractUrlProtectionSpec(
      makeCtx([
        {
          name: 's',
          fields: {
            enabled: true,
            csrf_prevention: 'All',
            allowed_methods: ['GET', 'POST', 'DELETE'],
            cross_site_scripting: 'strict',
            custom_blocked_attack_type_groups: ['group-b'],
          },
        },
      ]).canvas,
    )
    const body = buildUrlProtectionBody(spec)
    expect(body.enabled).toBe(true)
    expect(body.csrf_prevention).toBe('All')
    expect(body.allowed_methods).toEqual(['GET', 'POST', 'DELETE'])
    expect(body.cross_site_scripting).toBe('strict')
    expect(body.custom_blocked_attack_type_groups).toEqual(['group-b'])
  })
})
