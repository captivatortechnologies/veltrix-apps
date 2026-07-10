import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { splitList } from '../../lib/acs'

// --- ACS HEC token constraints (see README for documentation sources) -------

/** HEC token names: alphanumeric plus underscore/hyphen, must start alphanumeric. */
export const HEC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const MAX_HEC_NAME_LENGTH = 100
/** Index names referenced by a token follow Splunk Cloud index naming rules. */
const INDEX_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ------

export interface HecTokenSpec {
  sectionName: string
  name: string
  defaultIndex?: string
  allowedIndexes: string[]
  defaultSource?: string
  defaultSourcetype?: string
  useAck?: boolean
  disabled?: boolean
}

/**
 * Shape of a token returned by GET /adminconfig/v2/inputs/http-event-collectors/{name}.
 * ACS wraps the entity: { "http-event-collector": { "spec": {...}, "token": "..." } }
 */
export interface LiveHecSpec {
  name?: string
  defaultIndex?: string
  allowedIndexes?: string[]
  defaultHost?: string
  defaultSource?: string
  defaultSourcetype?: string
  useAck?: boolean
  disabled?: boolean
}

export interface LiveHecEntity {
  spec: LiveHecSpec
  token?: string
}

/** Unwrap the ACS response envelope; tolerates both wrapped and bare shapes. */
export function parseHecEntity(parsed: unknown): LiveHecEntity | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const wrapped = obj['http-event-collector'] as Record<string, unknown> | undefined
  const candidate = wrapped ?? obj
  const spec = (candidate.spec ?? candidate) as LiveHecSpec
  const token = typeof candidate.token === 'string' ? candidate.token : undefined
  return { spec, token }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas section describes one HEC token. */
export function extractHecTokenSpecs(canvas: CanvasSnapshot): HecTokenSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      defaultIndex: stringOrUndefined(fields.defaultIndex),
      allowedIndexes: splitList(fields.allowedIndexes),
      defaultSource: stringOrUndefined(fields.defaultSource),
      defaultSourcetype: stringOrUndefined(fields.defaultSourcetype),
      useAck: typeof fields.useAck === 'boolean' ? fields.useAck : undefined,
      disabled: typeof fields.disabled === 'boolean' ? fields.disabled : undefined,
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate HEC token configurations against ACS constraints: token naming,
 * index references, default/allowed index consistency, and acknowledgement
 * support. Token *values* must never appear in a canvas — ACS generates them.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenNames = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Token name
    const name = fields.name as string | undefined
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'HEC token name is required', code: 'required' })
    } else {
      const trimmed = name.trim()
      if (!HEC_NAME_RE.test(trimmed)) {
        errors.push({
          field: `${prefix}.name`,
          message:
            'HEC token name must start with a letter or number and contain only letters, numbers, underscores, and hyphens',
          code: 'invalid_format',
        })
      }
      if (trimmed.length > MAX_HEC_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `HEC token name must be ${MAX_HEC_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (seenNames.has(trimmed)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate HEC token "${trimmed}" — each token may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(trimmed)
    }

    // Never allow token secrets in configuration-as-code
    if (fields.token !== undefined && fields.token !== null && String(fields.token).trim() !== '') {
      errors.push({
        field: `${prefix}.token`,
        message:
          'Do not store HEC token values in the canvas — ACS generates the token value at creation time',
        code: 'token_in_canvas',
      })
    }

    // defaultIndex
    const defaultIndex = fields.defaultIndex as string | undefined
    if (!defaultIndex || typeof defaultIndex !== 'string' || defaultIndex.trim() === '') {
      warnings.push({
        field: `${prefix}.defaultIndex`,
        message:
          'No default index specified — ACS will route events to "default". Ensure that index exists or events will be lost.',
        code: 'no_default_index',
      })
    } else if (!INDEX_NAME_RE.test(defaultIndex.trim())) {
      errors.push({
        field: `${prefix}.defaultIndex`,
        message: 'Default index must be a valid Splunk Cloud index name',
        code: 'invalid_format',
      })
    }

    // allowedIndexes
    const allowedIndexes = splitList(fields.allowedIndexes)
    for (const idx of allowedIndexes) {
      if (!INDEX_NAME_RE.test(idx)) {
        errors.push({
          field: `${prefix}.allowedIndexes`,
          message: `"${idx}" is not a valid Splunk Cloud index name`,
          code: 'invalid_format',
        })
      }
    }
    if (
      allowedIndexes.length > 0 &&
      typeof defaultIndex === 'string' &&
      defaultIndex.trim() !== '' &&
      !allowedIndexes.includes(defaultIndex.trim())
    ) {
      errors.push({
        field: `${prefix}.allowedIndexes`,
        message: `Default index "${defaultIndex.trim()}" must be included in the allowed indexes list`,
        code: 'default_not_allowed',
      })
    }

    // useAck
    if (fields.useAck === true) {
      warnings.push({
        field: `${prefix}.useAck`,
        message:
          'Indexer acknowledgement on Splunk Cloud is currently supported only for AWS Kinesis Data Firehose sources',
        code: 'ack_limited',
      })
    }

    // disabled
    if (fields.disabled === true) {
      warnings.push({
        field: `${prefix}.disabled`,
        message: 'Token will be deployed in a disabled state and will not accept events',
        code: 'deployed_disabled',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
