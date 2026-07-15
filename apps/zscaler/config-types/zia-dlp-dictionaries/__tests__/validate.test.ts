import validate, { extractDlpDictionarySpecs } from '../validate'
import { buildPayload } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'zscaler',
    customerId: 'cust-1',
    configTypeId: 'zia-dlp-dictionaries',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'zscaler',
      entityType: 'zia-dlp-dictionaries',
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

describe('ZIA DLP Dictionaries Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a dictionary with phrases', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'DLP Dictionary',
          fields: { name: 'Project Codenames', description: 'Secret projects', phrases: 'Bluebird\nRedfox' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a dictionary with only patterns', async () => {
    const result = await validate(
      makeCtx([{ name: 'DLP Dictionary', fields: { name: 'CC Numbers', patterns: '\\d{16}' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { phrases: 'Bluebird' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Secrets', phrases: 'x' } },
        { name: 'b', fields: { name: 'secrets', patterns: 'y' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dlp_dictionary')).toBe(true)
  })

  it('rejects a dictionary with no phrases and no patterns', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Empty' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('phrases'))).toBe(true)
  })

  it('rejects an invalid dictionary_type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad', dictionary_type: 'NONSENSE', phrases: 'x' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('extractDlpDictionarySpecs trims fields and applies defaults', () => {
    const specs = extractDlpDictionarySpecs(
      makeCtx([
        { name: 'DLP Dictionary', fields: { name: '  Codenames  ', phrases: ' Bluebird \n\n Redfox ', patterns: '' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Codenames')
    expect(specs[0].phrases).toEqual(['Bluebird', 'Redfox'])
    expect(specs[0].patterns).toEqual([])
    expect(specs[0].dictionaryType).toBe('PATTERNS_AND_PHRASES')
    expect(specs[0].customPhraseMatchType).toBe('MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY')
  })

  it('buildPayload maps phrases/patterns to ZIA entries and marks the dictionary custom', () => {
    const [spec] = extractDlpDictionarySpecs(
      makeCtx([
        {
          name: 'DLP Dictionary',
          fields: { name: 'Mixed', phrases: 'Bluebird', patterns: '\\d{16}' },
        },
      ]).canvas,
    )
    const body = buildPayload(spec)
    expect(body.name).toBe('Mixed')
    expect(body.custom).toBe(true)
    expect(body.dictionaryType).toBe('PATTERNS_AND_PHRASES')
    expect(body.customPhraseMatchType).toBe('MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY')
    expect(body.phrases).toEqual([{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'Bluebird' }])
    expect(body.patterns).toEqual([{ action: 'PATTERN_COUNT_TYPE_ALL', pattern: '\\d{16}' }])
  })
})
