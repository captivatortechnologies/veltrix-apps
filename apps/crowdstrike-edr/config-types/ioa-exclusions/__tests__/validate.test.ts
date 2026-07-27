import validate, { extractIoaExclusionSpecs, regexCompiles } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ioa-exclusions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ioa-exclusions',
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

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Allow build tool',
    description: 'CI runner false positive',
    patternId: '12345',
    patternName: 'Suspicious Script',
    clRegex: '.*\\\\build\\.exe.*',
    ifnRegex: '.*',
    appliedGlobally: false,
    hostGroups: 'group-id-1',
    comment: 'Build noise',
    ...overrides,
  }
}

describe('CrowdStrike IOA Exclusions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid exclusion configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a missing pattern id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ patternId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.patternId'))).toBe(true)
  })

  it('rejects a command-line regex that does not compile', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ clRegex: '([unclosed' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_regex')).toBe(true)
  })

  it('requires both regex fields', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ ifnRegex: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.ifnRegex') && e.code === 'required')).toBe(true)
  })

  it('warns when a regex exceeds the length limit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ clRegex: 'a'.repeat(300) }) }]),
    )
    expect(result.warnings.some((w) => w.code === 'regex_too_long')).toBe(true)
  })

  it('requires host groups when not applied globally', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ appliedGlobally: false, hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.hostGroups'))).toBe(true)
  })

  it('allows a globally-applied exclusion with no host groups', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ appliedGlobally: true, hostGroups: '' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ name: 'ALLOW BUILD TOOL' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_exclusion')).toBe(true)
  })
})

describe('regexCompiles', () => {
  it('returns true for a valid pattern', () => {
    expect(regexCompiles('.*\\.exe')).toBe(true)
  })

  it('returns false for an invalid pattern', () => {
    expect(regexCompiles('([')).toBe(false)
  })
})

describe('extractIoaExclusionSpecs', () => {
  it('parses fields and defaults appliedGlobally to false', () => {
    const sections = [
      {
        name: 'sec1',
        fields: { name: 'x', patternId: '1', clRegex: '.*', ifnRegex: '.*', hostGroups: 'g1, g2' },
      },
    ]
    const specs = extractIoaExclusionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ioa-exclusions',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].appliedGlobally).toBe(false)
    expect(specs[0].patternId).toBe('1')
  })
})
