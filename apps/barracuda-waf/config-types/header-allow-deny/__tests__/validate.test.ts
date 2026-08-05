import validate, { buildHeaderRuleBody, extractHeaderRuleSpecs, headerRuleKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'header-allow-deny',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'header-allow-deny',
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

const GOOD_FIELDS = {
  name: 'test_rule_waas',
  header_name: 'barracuda',
  enabled: true,
  active: true,
  max_header_value_length: 256,
  denied_metacharacters: '%7f',
  block_sql_injection: false,
  block_os_command_injection: true,
  block_directory_traversal: false,
  block_cross_site_scripting: false,
  block_remote_file_inclusion: false,
  block_sql_injection_strict: false,
  block_os_command_injection_strict: false,
  block_directory_traversal_strict: false,
  block_cross_site_scripting_strict: false,
  block_remote_file_inclusion_strict: false,
  block_ldap_injection: false,
  block_python_php_attacks: false,
  block_http_specific_injection: false,
  block_apache_struts_attacks: false,
  block_apache_struts_attacks_strict: false,
  comments: 'ticket-123',
  exception_patterns: ['/api/*'],
  custom_blocked_attack_type_groups: ['legacy-group'],
}

describe('Barracuda WAF Header Allow/Deny Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete rule', async () => {
    const result = await validate(makeCtx([{ name: 'Rule', fields: GOOD_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { header_name: 'Cookie' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing header_name', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { name: 'rule1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('header_name'))).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'rule1', header_name: 'Cookie' } },
        { name: 'b', fields: { name: 'RULE1', header_name: 'Authorization' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a negative max_header_value_length', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: { name: 'rule1', header_name: 'Cookie', max_header_value_length: -5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_length')).toBe(true)
  })

  it('extractHeaderRuleSpecs defaults enabled/active to true and every block_* to false', () => {
    const specs = extractHeaderRuleSpecs(makeCtx([{ name: 's', fields: { name: 'rule1', header_name: 'Cookie' } }]).canvas)
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].active).toBe(true)
    expect(specs[0].maxHeaderValueLength).toBeNull()
    expect(specs[0].deniedMetacharacters).toBe('')
    expect(specs[0].comments).toBeNull()
    expect(specs[0].exceptionPatterns).toEqual([])
    expect(specs[0].customBlockedAttackTypeGroups).toEqual([])
    expect(specs[0].blockSqlInjection).toBe(false)
    expect(specs[0].blockOsCommandInjectionStrict).toBe(false)
    expect(specs[0].blockApacheStrutsAttacksStrict).toBe(false)
  })

  it('headerRuleKey lower-cases and trims', () => {
    expect(headerRuleKey(' Rule1 ')).toBe('rule1')
  })

  it('buildHeaderRuleBody maps the spec onto the wire shape, including the 15 block_* fields', () => {
    const specs = extractHeaderRuleSpecs(makeCtx([{ name: 's', fields: GOOD_FIELDS }]).canvas)
    expect(buildHeaderRuleBody(specs[0])).toEqual({
      name: 'test_rule_waas',
      header_name: 'barracuda',
      enabled: true,
      active: true,
      max_header_value_length: 256,
      denied_metacharacters: '%7f',
      block_sql_injection: false,
      block_os_command_injection: true,
      block_directory_traversal: false,
      block_cross_site_scripting: false,
      block_remote_file_inclusion: false,
      block_sql_injection_strict: false,
      block_os_command_injection_strict: false,
      block_directory_traversal_strict: false,
      block_cross_site_scripting_strict: false,
      block_remote_file_inclusion_strict: false,
      block_ldap_injection: false,
      block_python_php_attacks: false,
      block_http_specific_injection: false,
      block_apache_struts_attacks: false,
      block_apache_struts_attacks_strict: false,
      comments: 'ticket-123',
      exception_patterns: ['/api/*'],
      custom_blocked_attack_type_groups: ['legacy-group'],
    })
  })

  it('buildHeaderRuleBody carries max_header_value_length/comments as null when unset', () => {
    const specs = extractHeaderRuleSpecs(makeCtx([{ name: 's', fields: { name: 'rule1', header_name: 'Cookie' } }]).canvas)
    const body = buildHeaderRuleBody(specs[0])
    expect(body.max_header_value_length).toBeNull()
    expect(body.comments).toBeNull()
  })
})
