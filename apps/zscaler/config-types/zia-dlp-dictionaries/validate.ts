import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA DLP Dictionary constraints ------------------------------------------

/** ZIA caps a DLP dictionary name and description at 255 characters. */
export const MAX_DICTIONARY_NAME_LENGTH = 255
export const MAX_DICTIONARY_DESCRIPTION_LENGTH = 255

/** The detection techniques ZIA accepts for a DLP dictionary. */
export const DICTIONARY_TYPES = ['PATTERNS_AND_PHRASES', 'EXACT_DATA_MATCH', 'INDEXED_DATA_MATCH'] as const
export const DEFAULT_DICTIONARY_TYPE: (typeof DICTIONARY_TYPES)[number] = 'PATTERNS_AND_PHRASES'

/** How a custom phrase/pattern dictionary combines its entries when matching. */
export const CUSTOM_PHRASE_MATCH_TYPES = [
  'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY',
  'MATCH_ANY_CUSTOM_PHRASE_PATTERN_DICTIONARY',
] as const
export const DEFAULT_CUSTOM_PHRASE_MATCH_TYPE: (typeof CUSTOM_PHRASE_MATCH_TYPES)[number] =
  'MATCH_ALL_CUSTOM_PHRASE_PATTERN_DICTIONARY'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DlpDictionarySpec {
  sectionName: string
  /** The dictionary name — its logical identity (list + match). */
  name: string
  description?: string
  /** One of DICTIONARY_TYPES (default PATTERNS_AND_PHRASES). */
  dictionaryType: string
  /** Phrase strings, one per line (mapped to PHRASE_COUNT_TYPE_ALL entries). */
  phrases: string[]
  /** Regex pattern strings, one per line (mapped to PATTERN_COUNT_TYPE_ALL entries). */
  patterns: string[]
  /** One of CUSTOM_PHRASE_MATCH_TYPES (default MATCH_ALL...). */
  customPhraseMatchType: string
}

/** A phrase entry in a DLP dictionary body / GET response. */
export interface DlpPhrase {
  action?: string
  phrase?: string
}

/** A pattern entry in a DLP dictionary body / GET response. */
export interface DlpPattern {
  action?: string
  pattern?: string
}

/** Shape of a DLP dictionary returned by GET /dlpDictionaries. */
export interface LiveDlpDictionary {
  id?: number
  name?: string
  description?: string
  dictionaryType?: string
  phrases?: DlpPhrase[]
  patterns?: DlpPattern[]
  customPhraseMatchType?: string
  /** false / absent for predefined (built-in) dictionaries — those are read-only. */
  custom?: boolean
}

/** Split a textarea value into trimmed, non-blank lines. */
function toLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA DLP dictionary. */
export function extractDlpDictionarySpecs(canvas: CanvasSnapshot): DlpDictionarySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const dictionaryType =
      typeof fields.dictionary_type === 'string' && fields.dictionary_type.trim()
        ? fields.dictionary_type.trim()
        : DEFAULT_DICTIONARY_TYPE
    const customPhraseMatchType =
      typeof fields.custom_phrase_match_type === 'string' && fields.custom_phrase_match_type.trim()
        ? fields.custom_phrase_match_type.trim()
        : DEFAULT_CUSTOM_PHRASE_MATCH_TYPE
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      dictionaryType,
      phrases: toLines(fields.phrases),
      patterns: toLines(fields.patterns),
      customPhraseMatchType,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate DLP dictionary configurations against ZIA constraints: a name is
 * required, capped at 255 chars, and unique across the canvas (matched
 * case-insensitively, since ZIA rejects dictionaries differing only in case);
 * the dictionary type and custom phrase match type must each be one of the
 * accepted values; and at least one phrase or pattern must be declared.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDlpDictionarySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'DLP dictionary name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DICTIONARY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `DLP dictionary name must be ${MAX_DICTIONARY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate DLP dictionary "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_dlp_dictionary',
        })
      }
      seen.add(key)
    }

    if (!DICTIONARY_TYPES.includes(spec.dictionaryType as (typeof DICTIONARY_TYPES)[number])) {
      errors.push({
        field: `${prefix}.dictionary_type`,
        message: `Dictionary type must be one of: ${DICTIONARY_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (
      !CUSTOM_PHRASE_MATCH_TYPES.includes(
        spec.customPhraseMatchType as (typeof CUSTOM_PHRASE_MATCH_TYPES)[number],
      )
    ) {
      errors.push({
        field: `${prefix}.custom_phrase_match_type`,
        message: `Custom phrase match type must be one of: ${CUSTOM_PHRASE_MATCH_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    if (spec.phrases.length === 0 && spec.patterns.length === 0) {
      errors.push({
        field: `${prefix}.phrases`,
        message: 'At least one phrase or pattern is required',
        code: 'required',
      })
    }

    if (spec.description && spec.description.length > MAX_DICTIONARY_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DICTIONARY_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
