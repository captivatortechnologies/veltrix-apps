import validate, { extractParameterProtectionSpec, buildParameterProtectionBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'parameter-protection',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'parameter-protection',
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

describe('Barracuda WAF Parameter Protection Validate Handler', () => {
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
          name: 'Parameter Protection',
          fields: {
            enabled: true,
            denied_metacharacters: '%00%01%04%1b%08%5c%7f',
            maximum_parameter_value_length: 100,
            maximum_instances: 1,
            base64_decode_parameter_value: false,
            validate_parameter_name: false,
            allowed_file_upload_types: 'all',
            file_upload_extensions: ['pdf', 'png'],
            file_upload_mime_types: ['application/pdf'],
            maximum_upload_file_size: 1024,
            ignore_parameters: ['comment'],
            exception_patterns: ['^test-'],
            sql_injection: 'normal',
            os_command_injection: 'normal',
            cross_site_scripting: 'normal',
            remote_file_inclusion: 'none',
            ldap_injection: 'normal',
            python_php_attacks: 'normal',
            http_specific_injection: 'normal',
            apache_struts_attacks: 'normal',
            directory_traversal: 'none',
            custom_blocked_attack_type_groups: ['custom-group-1'],
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a non-positive maximum parameter value length', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { maximum_parameter_value_length: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_length')).toBe(true)
  })

  it('rejects a non-positive maximum instances', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { maximum_instances: -1 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_instances')).toBe(true)
  })

  it('rejects a non-positive maximum upload file size', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { maximum_upload_file_size: 0 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_upload_size')).toBe(true)
  })

  it('extractParameterProtectionSpec applies the documented field defaults', () => {
    const spec = extractParameterProtectionSpec(makeCtx([{ name: 's', fields: {} }]).canvas)
    expect(spec.enabled).toBe(false)
    expect(spec.maximumParameterValueLength).toBe(100)
    expect(spec.maximumInstances).toBe(1)
    expect(spec.maximumUploadFileSize).toBe(1024)
    expect(spec.allowedFileUploadTypes).toBe('all')
    expect(spec.fileUploadExtensions).toEqual([])
    expect(spec.attackTypes.sqlInjection).toBe('none')
    expect(spec.attackTypes.customBlockedAttackTypeGroups).toEqual([])
  })

  it('buildParameterProtectionBody maps the spec — including the attack-type sub-shape — onto the wire shape', () => {
    const spec = extractParameterProtectionSpec(
      makeCtx([
        {
          name: 's',
          fields: {
            enabled: true,
            maximum_parameter_value_length: 200,
            file_upload_extensions: ['pdf'],
            sql_injection: 'normal',
            directory_traversal: 'strict',
            custom_blocked_attack_type_groups: ['group-a'],
          },
        },
      ]).canvas,
    )
    const body = buildParameterProtectionBody(spec)
    expect(body.enabled).toBe(true)
    expect(body.maximum_parameter_value_length).toBe(200)
    expect(body.file_upload_extensions).toEqual(['pdf'])
    expect(body.sql_injection).toBe('normal')
    expect(body.directory_traversal).toBe('strict')
    expect(body.custom_blocked_attack_type_groups).toEqual(['group-a'])
  })
})
