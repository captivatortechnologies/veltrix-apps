import validate, {
  extractPolicySpecs,
  parsePolicyGeneralXml,
  parsePolicyPackagesXml,
  parsePolicyScopeXml,
  parsePolicyScriptsXml,
  policyKey,
  readBool,
  strList,
  tryParseJsonArray,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'jamf',
    customerId: 'cust-1',
    configTypeId: 'policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'jamf',
      entityType: 'policies',
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

const validFields = {
  name: 'Install Rosetta',
  enabled: true,
  frequency: 'Once per computer',
  triggers: ['trigger_checkin', 'trigger_login'],
  all_computers: false,
  computer_group_names: ['Apple Silicon Macs'],
  scripts_json: JSON.stringify([{ name: 'install-rosetta.sh', priority: 'After' }]),
  packages_json: JSON.stringify([{ name: 'Rosetta.pkg', action: 'Install' }]),
}

describe('Jamf Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully populated policy', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('validates a minimal policy with no scripts/packages/scope', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { name: 'Bare Policy' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { frequency: 'Ongoing' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported frequency', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...validFields, frequency: 'Hourly' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_frequency')).toBe(true)
  })

  it('rejects invalid scripts_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...validFields, scripts_json: '{not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('scripts_json') && e.code === 'invalid_json')).toBe(true)
  })

  it('rejects invalid packages_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec', fields: { ...validFields, packages_json: '"nope"' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('packages_json') && e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a script entry with no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { ...validFields, scripts_json: JSON.stringify([{ priority: 'Before' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('scripts_json[0].name'))).toBe(true)
  })

  it('rejects a package entry with no name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec', fields: { ...validFields, packages_json: JSON.stringify([{ action: 'Install' }]) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('packages_json[0].name'))).toBe(true)
  })

  it('rejects duplicate policy names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Baseline' } },
        { name: 'b', fields: { ...validFields, name: 'baseline' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_policy')).toBe(true)
  })

  it('policyKey normalizes case and whitespace', () => {
    expect(policyKey('  Baseline ')).toBe('baseline')
  })

  it('readBool parses booleans, string booleans and falls back', () => {
    expect(readBool(true, false)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(readBool(undefined, true)).toBe(true)
  })

  it('strList handles arrays, comma strings and blanks', () => {
    expect(strList(['a', ' b ', ''])).toEqual(['a', 'b'])
    expect(strList('a, b ,')).toEqual(['a', 'b'])
    expect(strList(undefined)).toEqual([])
  })

  it('tryParseJsonArray treats blank text as an empty ok list and rejects non-arrays', () => {
    expect(tryParseJsonArray('')).toEqual({ value: [], ok: true })
    expect(tryParseJsonArray('{"a":1}').ok).toBe(false)
  })

  it('extractPolicySpecs maps triggers multiselect into individual boolean flags', () => {
    const specs = extractPolicySpecs(makeCtx([{ name: 'sec', fields: validFields }]).canvas)
    const spec = specs[0]
    expect(spec.trigger_checkin).toBe(true)
    expect(spec.trigger_login).toBe(true)
    expect(spec.trigger_logout).toBe(false)
    expect(spec.trigger_startup).toBe(false)
    expect(spec.scripts).toEqual([{ name: 'install-rosetta.sh', priority: 'After' }])
    expect(spec.packages).toEqual([{ name: 'Rosetta.pkg', action: 'Install' }])
    expect(spec.computerGroupNames).toEqual(['Apple Silicon Macs'])
  })

  it('extractPolicySpecs defaults frequency and coerces malformed script/package entries safely', () => {
    const specs = extractPolicySpecs(
      makeCtx([
        {
          name: 'sec',
          fields: {
            name: 'Weird',
            scripts_json: JSON.stringify([{ name: 'x' }, 'not-an-object']),
            packages_json: JSON.stringify([{ name: 'y', action: 'Nonsense' }]),
          },
        },
      ]).canvas,
    )
    expect(specs[0].frequency).toBe('Once per computer')
    expect(specs[0].scripts).toEqual([
      { name: 'x', priority: 'After' },
      { name: '', priority: 'After' },
    ])
    expect(specs[0].packages).toEqual([{ name: 'y', action: 'Install' }])
  })

  describe('live Classic XML parsing', () => {
    it('parsePolicyGeneralXml reads name/enabled/frequency/triggers', () => {
      const xml =
        '<general><id>1</id><name>Baseline</name><enabled>true</enabled>' +
        '<trigger_checkin>true</trigger_checkin><trigger_login>false</trigger_login>' +
        '<frequency>Ongoing</frequency></general>'
      const parsed = parsePolicyGeneralXml(xml)
      expect(parsed.name).toBe('Baseline')
      expect(parsed.enabled).toBe(true)
      expect(parsed.frequency).toBe('Ongoing')
      expect(parsed.trigger_checkin).toBe(true)
      expect(parsed.trigger_login).toBe(false)
      expect(parsed.trigger_startup).toBe(false)
    })

    it('parsePolicyScopeXml reads all_computers, group names and exclusion group names', () => {
      const xml =
        '<scope><all_computers>false</all_computers>' +
        '<computer_groups><computer_group><id>1</id><name>Fleet A</name></computer_group></computer_groups>' +
        '<exclusions><computer_groups><computer_group><id>2</id><name>Fleet B</name></computer_group></computer_groups></exclusions>' +
        '</scope>'
      const parsed = parsePolicyScopeXml(xml)
      expect(parsed.allComputers).toBe(false)
      expect(parsed.groupNames).toEqual(['Fleet A'])
      expect(parsed.exclusionGroupNames).toEqual(['Fleet B'])
    })

    it('parsePolicyScopeXml handles an empty scope', () => {
      const xml = '<scope><all_computers>true</all_computers><computer_groups/></scope>'
      const parsed = parsePolicyScopeXml(xml)
      expect(parsed.allComputers).toBe(true)
      expect(parsed.groupNames).toEqual([])
      expect(parsed.exclusionGroupNames).toEqual([])
    })

    it('parsePolicyScriptsXml reads name and priority', () => {
      const xml = '<scripts><script><id>1</id><name>a.sh</name><priority>Before</priority></script></scripts>'
      expect(parsePolicyScriptsXml(xml)).toEqual([{ name: 'a.sh', priority: 'Before' }])
    })

    it('parsePolicyPackagesXml reads name and action', () => {
      const xml = '<package_configuration><packages><package><id>1</id><name>Firefox.pkg</name><action>Cache</action></package></packages></package_configuration>'
      expect(parsePolicyPackagesXml(xml)).toEqual([{ name: 'Firefox.pkg', action: 'Cache' }])
    })

    it('parsePolicyPackagesXml handles a missing packages block', () => {
      expect(parsePolicyPackagesXml('<package_configuration></package_configuration>')).toEqual([])
    })
  })
})
