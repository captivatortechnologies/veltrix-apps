import validate, {
  MAX_NAME_LENGTH,
  extractPasswordPolicySpecs,
  MIN_CHAR_LOWERCASE_KEY,
  MIN_CHAR_NUMERIC_KEY,
  MIN_CHAR_SPECIAL_KEY,
  MIN_CHAR_UPPERCASE_KEY,
} from '../validate'
import { buildPasswordPolicyBody, stripReadOnlyPolicyFields } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'ping-identity',
    customerId: 'cust-1',
    configTypeId: 'password-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'ping-identity',
      entityType: 'password-policies',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'ping-identity',
    entityType: 'password-policies',
    items: sections,
    sections,
    snapshot: {},
  }
}

const MINIMAL_FIELDS = { name: 'Standard Policy', minLength: 8 }

describe('PingOne Password Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid policy', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: MINIMAL_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a fully-populated valid policy', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Policy',
          fields: {
            name: 'Strict Policy',
            description: 'A strict policy',
            default: true,
            excludesCommonlyUsedPasswords: true,
            excludesProfileData: true,
            notSimilarToCurrent: true,
            minLength: 12,
            maxLength: 64,
            historyCount: 5,
            historyRetentionDays: 90,
            maxAgeDays: 90,
            minAgeDays: 1,
            lockoutFailureCount: 5,
            lockoutDurationSeconds: 900,
            minCharUppercase: 1,
            minCharLowercase: 1,
            minCharNumeric: 1,
            minCharSpecial: 1,
            minComplexity: 7,
            minUniqueCharacters: 5,
            maxRepeatedCharacters: 2,
            alphabetSequenceMaxLength: 3,
            numberSequenceMaxLength: 2,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { minLength: 8 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it(`rejects a name longer than ${MAX_NAME_LENGTH} characters`, async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'x'.repeat(MAX_NAME_LENGTH + 1), minLength: 8 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects a duplicate policy name (exact, case-sensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Standard', minLength: 8 } },
        { name: 'sec2', fields: { name: 'Standard', minLength: 8 } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('does not treat differently-cased names as duplicates (PingOne matches case-sensitively)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'Standard', minLength: 8 } },
        { name: 'sec2', fields: { name: 'standard', minLength: 8 } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(false)
  })

  it('rejects a missing minLength', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'No Min' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('minLength'))).toBe(true)
  })

  it.each([7, 33])('rejects minLength outside 8-32 (%d)', async (minLength) => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Bad Min', minLength } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects maxLength below minLength', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'Bad Max', minLength: 16, maxLength: 10 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length_below_min')).toBe(true)
  })

  it('rejects minComplexity other than 7', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minComplexity: 5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_min_complexity')).toBe(true)
  })

  it('accepts minComplexity of exactly 7', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minComplexity: 7 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects minUniqueCharacters other than 5', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minUniqueCharacters: 3 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_min_unique_characters')).toBe(true)
  })

  it('rejects maxRepeatedCharacters other than 2', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, maxRepeatedCharacters: 4 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_repeated_characters')).toBe(true)
  })

  it('rejects maxAgeDays that does not exceed minAgeDays + 21', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minAgeDays: 5, maxAgeDays: 26 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_max_age_days')).toBe(true)
  })

  it('accepts maxAgeDays just above minAgeDays + 21', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minAgeDays: 5, maxAgeDays: 27 } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('applies the +21 rule against an implicit minAgeDays of 0 when minAgeDays is unset', async () => {
    const tooLow = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, maxAgeDays: 21 } }]))
    expect(tooLow.valid).toBe(false)
    expect(tooLow.errors.some((e) => e.code === 'invalid_max_age_days')).toBe(true)

    const okValue = await validate(makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, maxAgeDays: 22 } }]))
    expect(okValue.valid).toBe(true)
  })

  it('rejects lockout fields set individually', async () => {
    const onlyFailure = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, lockoutFailureCount: 5 } }]),
    )
    expect(onlyFailure.valid).toBe(false)
    expect(onlyFailure.errors.some((e) => e.code === 'lockout_pairing')).toBe(true)

    const onlyDuration = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, lockoutDurationSeconds: 900 } }]),
    )
    expect(onlyDuration.valid).toBe(false)
    expect(onlyDuration.errors.some((e) => e.code === 'lockout_pairing')).toBe(true)
  })

  it('accepts lockout fields set together or both blank', async () => {
    const both = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, lockoutFailureCount: 5, lockoutDurationSeconds: 900 } }]),
    )
    expect(both.valid).toBe(true)

    const neither = await validate(makeCtx([{ name: 'sec1', fields: MINIMAL_FIELDS }]))
    expect(neither.valid).toBe(true)
  })

  it('rejects history fields set individually', async () => {
    const onlyCount = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, historyCount: 5 } }]),
    )
    expect(onlyCount.valid).toBe(false)
    expect(onlyCount.errors.some((e) => e.code === 'history_pairing')).toBe(true)

    const onlyRetention = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, historyRetentionDays: 90 } }]),
    )
    expect(onlyRetention.valid).toBe(false)
    expect(onlyRetention.errors.some((e) => e.code === 'history_pairing')).toBe(true)
  })

  it.each([1, 4, 5])('rejects an alphabetSequenceMaxLength of %d (only 2 or 3 allowed)', async (value) => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, alphabetSequenceMaxLength: value } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_alphabet_sequence_max_length')).toBe(true)
  })

  it.each([1, 4, 5])('rejects a numberSequenceMaxLength of %d (only 2 or 3 allowed)', async (value) => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, numberSequenceMaxLength: value } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_number_sequence_max_length')).toBe(true)
  })

  it('rejects a negative numeric field', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minCharUppercase: -1 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects a non-integer numeric field', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...MINIMAL_FIELDS, minCharUppercase: 1.5 } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('warns (but does not invalidate) when more than one policy is marked default', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'A', minLength: 8, default: true } },
        { name: 'sec2', fields: { name: 'B', minLength: 8, default: true } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'multiple_defaults')).toBe(true)
  })
})

describe('extractPasswordPolicySpecs', () => {
  it('trims text fields and coerces numeric strings', () => {
    const specs = extractPasswordPolicySpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: { name: '  Office Policy  ', description: '  desc  ', minLength: '10' },
        },
      ]),
    )
    expect(specs[0].name).toBe('Office Policy')
    expect(specs[0].description).toBe('desc')
    expect(specs[0].minLength).toBe(10)
  })

  it('leaves default undefined when the field is absent', () => {
    const specs = extractPasswordPolicySpecs(makeCanvas([{ name: 'sec1', fields: { name: 'A', minLength: 8 } }]))
    expect(specs[0].default).toBeUndefined()
  })

  it('coerces boolean rule flags, defaulting to false', () => {
    const specs = extractPasswordPolicySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'A', minLength: 8, excludesProfileData: true } }]),
    )
    expect(specs[0].excludesCommonlyUsedPasswords).toBe(false)
    expect(specs[0].excludesProfileData).toBe(true)
    expect(specs[0].notSimilarToCurrent).toBe(false)
  })
})

describe('buildPasswordPolicyBody', () => {
  const baseSpec = {
    sectionName: 's',
    name: 'Standard',
    excludesCommonlyUsedPasswords: false,
    excludesProfileData: false,
    notSimilarToCurrent: false,
    minLength: 8,
  }

  it('builds a minimal body with only the required fields', () => {
    const body = buildPasswordPolicyBody(baseSpec)
    expect(body).toEqual({
      name: 'Standard',
      excludesCommonlyUsedPasswords: false,
      excludesProfileData: false,
      notSimilarToCurrent: false,
      length: { min: 8 },
    })
  })

  it('includes maxLength on the length object when set', () => {
    const body = buildPasswordPolicyBody({ ...baseSpec, maxLength: 64 })
    expect(body.length).toEqual({ min: 8, max: 64 })
  })

  it('omits history/lockout when only one side of the pair is set', () => {
    const body = buildPasswordPolicyBody({ ...baseSpec, historyCount: 5, lockoutFailureCount: 5 })
    expect(body.history).toBeUndefined()
    expect(body.lockout).toBeUndefined()
  })

  it('includes history/lockout when both sides of the pair are set', () => {
    const body = buildPasswordPolicyBody({
      ...baseSpec,
      historyCount: 5,
      historyRetentionDays: 90,
      lockoutFailureCount: 5,
      lockoutDurationSeconds: 900,
    })
    expect(body.history).toEqual({ count: 5, retentionDays: 90 })
    expect(body.lockout).toEqual({ failureCount: 5, durationSeconds: 900 })
  })

  it('assembles minCharacters using the literal PingOne character-class keys', () => {
    const body = buildPasswordPolicyBody({
      ...baseSpec,
      minCharUppercase: 1,
      minCharLowercase: 2,
      minCharNumeric: 3,
      minCharSpecial: 4,
    })
    expect(body.minCharacters).toEqual({
      [MIN_CHAR_UPPERCASE_KEY]: 1,
      [MIN_CHAR_LOWERCASE_KEY]: 2,
      [MIN_CHAR_NUMERIC_KEY]: 3,
      [MIN_CHAR_SPECIAL_KEY]: 4,
    })
  })

  it('omits minCharacters entirely when every counter is zero or unset', () => {
    const body = buildPasswordPolicyBody({ ...baseSpec, minCharUppercase: 0 })
    expect(body.minCharacters).toBeUndefined()
  })

  it('includes only the counters with a meaningful (> 0) value', () => {
    const body = buildPasswordPolicyBody({ ...baseSpec, minCharUppercase: 1, minCharLowercase: 0 })
    expect(body.minCharacters).toEqual({ [MIN_CHAR_UPPERCASE_KEY]: 1 })
  })

  it('includes alphabetSequenceRule/numberSequenceRule only when their max length is set', () => {
    const body = buildPasswordPolicyBody({ ...baseSpec, alphabetSequenceMaxLength: 3 })
    expect(body.alphabetSequenceRule).toEqual({ maxLength: 3 })
    expect(body.numberSequenceRule).toBeUndefined()
  })

  it('includes description and default only when set', () => {
    const withBoth = buildPasswordPolicyBody({ ...baseSpec, description: 'desc', default: true })
    expect(withBoth.description).toBe('desc')
    expect(withBoth.default).toBe(true)

    const withNeither = buildPasswordPolicyBody(baseSpec)
    expect(withNeither.description).toBeUndefined()
    expect(withNeither.default).toBeUndefined()
  })

  it('passes maxAgeDays/minAgeDays/minComplexity/minUniqueCharacters/maxRepeatedCharacters through as-is', () => {
    const body = buildPasswordPolicyBody({
      ...baseSpec,
      maxAgeDays: 90,
      minAgeDays: 1,
      minComplexity: 7,
      minUniqueCharacters: 5,
      maxRepeatedCharacters: 2,
    })
    expect(body.maxAgeDays).toBe(90)
    expect(body.minAgeDays).toBe(1)
    expect(body.minComplexity).toBe(7)
    expect(body.minUniqueCharacters).toBe(5)
    expect(body.maxRepeatedCharacters).toBe(2)
  })
})

describe('stripReadOnlyPolicyFields', () => {
  it('removes id/environment/createdAt/updatedAt/_links/populationCount but keeps the rest', () => {
    const stripped = stripReadOnlyPolicyFields({
      id: 'pwp123',
      name: 'Standard',
      environment: { id: 'env1' },
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-02T00:00:00Z',
      _links: { self: {} },
      populationCount: 42,
      length: { min: 8 },
      excludesCommonlyUsedPasswords: true,
    })
    expect(stripped).toEqual({
      name: 'Standard',
      length: { min: 8 },
      excludesCommonlyUsedPasswords: true,
    })
    expect(stripped.id).toBeUndefined()
    expect(stripped.populationCount).toBeUndefined()
  })
})
