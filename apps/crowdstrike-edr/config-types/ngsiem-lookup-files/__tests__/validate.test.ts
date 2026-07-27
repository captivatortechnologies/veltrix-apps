import validate, {
  extractLookupSpecs,
  parseCsvHeader,
  DEFAULT_SEARCH_DOMAIN,
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
    configTypeId: 'ngsiem-lookup-files',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-lookup-files',
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

const CSV = 'hostname,owner,team\nweb-01,alice,platform\nweb-02,bob,platform'

function validLookupFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: 'asset-owners.csv',
    repository: 'all',
    content: CSV,
    keyColumns: 'hostname',
    ...overrides,
  }
}

describe('CrowdStrike NG-SIEM Lookup Files Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid lookup file configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Lookup', fields: validLookupFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing filename', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ filename: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a filename that is not .csv', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ filename: 'owners.txt' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'not_csv')).toBe(true)
  })

  it('rejects a filename with illegal characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ filename: 'bad name.csv' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_filename')).toBe(true)
  })

  it('rejects empty CSV content', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ content: '   ' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_content')).toBe(true)
  })

  it('rejects a key column missing from the CSV header', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ keyColumns: 'nonexistent' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'key_column_missing')).toBe(true)
  })

  it('warns when no key columns are declared', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validLookupFields({ keyColumns: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_key_columns')).toBe(true)
  })

  it('rejects duplicate filenames across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validLookupFields() },
        { name: 'sec2', fields: validLookupFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_filename')).toBe(true)
  })
})

describe('parseCsvHeader', () => {
  it('parses the first non-empty line into trimmed columns', () => {
    expect(parseCsvHeader('\n hostname , owner \nweb-01,alice')).toEqual(['hostname', 'owner'])
  })

  it('returns an empty array for blank content', () => {
    expect(parseCsvHeader('   \n  ')).toHaveLength(0)
  })
})

describe('extractLookupSpecs', () => {
  it('defaults the repository, trims filename, and splits key columns', () => {
    const specs = extractLookupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-lookup-files',
      items: [],
      sections: [
        { name: 'sec1', fields: { filename: '  a.csv  ', content: CSV, keyColumns: 'hostname, owner' } },
      ],
      snapshot: {},
    })
    expect(specs[0].filename).toBe('a.csv')
    expect(specs[0].repository).toBe(DEFAULT_SEARCH_DOMAIN)
    expect(specs[0].keyColumns).toEqual(['hostname', 'owner'])
  })

  it('preserves CSV content verbatim', () => {
    const specs = extractLookupSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-lookup-files',
      items: [],
      sections: [{ name: 'sec1', fields: { filename: 'a.csv', content: 'x,y\n1,2\n' } }],
      snapshot: {},
    })
    expect(specs[0].content).toBe('x,y\n1,2\n')
  })
})
