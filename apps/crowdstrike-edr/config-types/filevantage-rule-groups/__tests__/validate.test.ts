import validate, {
  parseRuleSpecs,
  extractRuleGroupSpecs,
  validateRulesForType,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'filevantage-rule-groups',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'filevantage-rule-groups',
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

function fileRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: 'C:\\Windows\\System32',
    severity: 'High',
    description: 'Monitor System32 changes',
    watch_write_file_changes: true,
    watch_delete_file_changes: true,
    ...overrides,
  }
}

function validGroupFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Windows System Files',
    type: 'WindowsFiles',
    description: 'Baseline OS file monitoring',
    rules: JSON.stringify([fileRule()]),
    ...overrides,
  }
}

describe('CrowdStrike FileVantage Rule Groups Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule group configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Group', fields: validGroupFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing rule group name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validGroupFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects unknown group types', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ type: 'SolarisFiles' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('normalizes group type casing to the canonical value', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ type: 'windowsfiles' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when a group declares no rules', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validGroupFields({ rules: '' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_rules')).toBe(true)
  })

  it('rejects invalid rules JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validGroupFields({ rules: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('rejects duplicate rule group names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validGroupFields() },
        { name: 'sec2', fields: validGroupFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a registry watched attribute on a file rule group', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validGroupFields({
            rules: JSON.stringify([fileRule({ watch_set_value_changes: true })]),
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_rules')).toBe(true)
  })

  it('validates a WindowsRegistry rule group with registry attributes', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: {
            name: 'Registry Run Keys',
            type: 'WindowsRegistry',
            rules: JSON.stringify([
              {
                path: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
                severity: 'Critical',
                description: 'Autorun persistence',
                watch_set_value_changes: true,
                watch_delete_value_changes: true,
              },
            ]),
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('parseRuleSpecs', () => {
  it('accepts a well-formed file rule and defaults depth to ANY', () => {
    const { rules, errors } = parseRuleSpecs(JSON.stringify([fileRule()]))
    expect(errors).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].path).toBe('C:\\Windows\\System32')
    expect(rules[0].depth).toBe('ANY')
    expect(rules[0].watchAttributes.watch_write_file_changes).toBe(true)
  })

  it('normalizes severity casing and accepts a numeric depth', () => {
    const { rules, errors } = parseRuleSpecs(
      JSON.stringify([fileRule({ severity: 'high', depth: 3 })]),
    )
    expect(errors).toHaveLength(0)
    expect(rules[0].severity).toBe('High')
    expect(rules[0].depth).toBe('3')
  })

  it('rejects a missing path', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([{ severity: 'High', description: 'd' }]),
    )
    expect(errors.some((e) => e.includes('path'))).toBe(true)
  })

  it('rejects an unknown severity', () => {
    const { errors } = parseRuleSpecs(JSON.stringify([fileRule({ severity: 'Urgent' })]))
    expect(errors.some((e) => e.includes('severity'))).toBe(true)
  })

  it('rejects a missing description', () => {
    const { errors } = parseRuleSpecs(
      JSON.stringify([{ path: 'C:\\X', severity: 'Low' }]),
    )
    expect(errors.some((e) => e.includes('description'))).toBe(true)
  })

  it('rejects an invalid depth', () => {
    const { errors } = parseRuleSpecs(JSON.stringify([fileRule({ depth: '9' })]))
    expect(errors.some((e) => e.includes('depth'))).toBe(true)
  })

  it('rejects an unknown watched attribute', () => {
    const { errors } = parseRuleSpecs(JSON.stringify([fileRule({ watch_nonsense_changes: true })]))
    expect(errors.some((e) => e.includes('unknown watched attribute'))).toBe(true)
  })

  it('rejects duplicate rule paths', () => {
    const { errors } = parseRuleSpecs(JSON.stringify([fileRule(), fileRule()]))
    expect(errors.some((e) => e.includes('more than once'))).toBe(true)
  })

  it('rejects a non-array rules payload', () => {
    const { errors } = parseRuleSpecs(JSON.stringify({ path: 'C:\\X' }))
    expect(errors.some((e) => e.includes('must be a JSON array'))).toBe(true)
  })

  it('returns empty rules for empty input', () => {
    expect(parseRuleSpecs(undefined)).toEqual({ rules: [], errors: [] })
  })

  it('parses include/exclude and content_files', () => {
    const { rules } = parseRuleSpecs(
      JSON.stringify([
        fileRule({ include: '*.exe', exclude: '*.tmp', content_files: ['a.dll', 'b.dll'] }),
      ]),
    )
    expect(rules[0].include).toBe('*.exe')
    expect(rules[0].exclude).toBe('*.tmp')
    expect(rules[0].contentFiles).toEqual(['a.dll', 'b.dll'])
  })
})

describe('validateRulesForType', () => {
  it('accepts file watched attributes for a WindowsFiles group', () => {
    const { rules } = parseRuleSpecs(JSON.stringify([fileRule()]))
    expect(validateRulesForType(rules, 'WindowsFiles')).toHaveLength(0)
  })

  it('rejects registry watched attributes on a file group', () => {
    const { rules } = parseRuleSpecs(
      JSON.stringify([fileRule({ watch_create_key_changes: true })]),
    )
    const errors = validateRulesForType(rules, 'LinuxFiles')
    expect(errors.some((e) => e.includes('not valid for a LinuxFiles'))).toBe(true)
  })

  it('requires content_files and the write toggle for file content capture', () => {
    const { rules } = parseRuleSpecs(
      JSON.stringify([fileRule({ enable_content_capture: true, watch_write_file_changes: false })]),
    )
    const errors = validateRulesForType(rules, 'WindowsFiles')
    expect(errors.some((e) => e.includes('content_files'))).toBe(true)
    expect(errors.some((e) => e.includes('watch_write_file_changes'))).toBe(true)
  })

  it('accepts a valid file content-capture rule', () => {
    const { rules } = parseRuleSpecs(
      JSON.stringify([
        fileRule({ enable_content_capture: true, content_files: ['*.conf'], watch_write_file_changes: true }),
      ]),
    )
    expect(validateRulesForType(rules, 'WindowsFiles')).toHaveLength(0)
  })

  it('requires content_registry_values and the set-value toggle for registry content capture', () => {
    const { rules } = parseRuleSpecs(
      JSON.stringify([
        {
          path: 'HKLM\\Software\\X',
          severity: 'Medium',
          description: 'reg content',
          enable_content_capture: true,
        },
      ]),
    )
    const errors = validateRulesForType(rules, 'WindowsRegistry')
    expect(errors.some((e) => e.includes('content_registry_values'))).toBe(true)
    expect(errors.some((e) => e.includes('watch_set_value_changes'))).toBe(true)
  })
})

describe('extractRuleGroupSpecs', () => {
  it('parses fields and normalizes type casing', () => {
    const specs = extractRuleGroupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'filevantage-rule-groups',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: 'g1', type: 'MACFILES', description: 'note' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('g1')
    expect(specs[0].type).toBe('MacFiles')
    expect(specs[0].description).toBe('note')
    expect(specs[0].rulesRaw).toBeUndefined()
  })
})
