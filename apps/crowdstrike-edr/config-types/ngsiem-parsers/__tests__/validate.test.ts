import validate, { extractParserSpecs, PARSER_REPOSITORY } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ngsiem-parsers',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-parsers',
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

const SCRIPT = 'parseJson()\n| kvParse()\n| $ecs:message := @rawstring'

function validParserFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'my-app-logs',
    repository: PARSER_REPOSITORY,
    datatype: 'myvendor:myapp',
    script: SCRIPT,
    enabled: true,
    ...overrides,
  }
}

describe('CrowdStrike NG-SIEM Parsers Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid parser configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Parser', fields: validParserFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing parser name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validParserFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an empty parser script', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validParserFields({ script: '   ' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_script')).toBe(true)
  })

  it('rejects duplicate parser names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validParserFields() },
        { name: 'sec2', fields: validParserFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a parser name over the length limit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validParserFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('warns about a non-standard repository but stays valid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validParserFields({ repository: 'custom-repo' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'nonstandard_repository')).toBe(true)
  })
})

describe('extractParserSpecs', () => {
  it('defaults the repository, trims fields, and coerces enabled', () => {
    const specs = extractParserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-parsers',
      items: [],
      sections: [
        { name: 'sec1', fields: { name: '  p1  ', script: SCRIPT, enabled: 'false' } },
      ],
      snapshot: {},
    })
    expect(specs[0].name).toBe('p1')
    expect(specs[0].repository).toBe(PARSER_REPOSITORY)
    expect(specs[0].enabled).toBe(false)
    expect(specs[0].datatype).toBeUndefined()
  })

  it('preserves script whitespace verbatim', () => {
    const specs = extractParserSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-parsers',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'p1', script: '  a\n  b\n' } }],
      snapshot: {},
    })
    expect(specs[0].script).toBe('  a\n  b\n')
  })
})
