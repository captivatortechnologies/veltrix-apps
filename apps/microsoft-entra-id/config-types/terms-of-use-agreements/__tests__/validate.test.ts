import validate, {
  buildTermsExpiration,
  effectiveFileName,
  effectiveLanguage,
  extractTermsOfUseSpecs,
  type TermsOfUseSpec,
} from '../validate'
import { buildCreateBody, buildPatchBody } from '../deploy'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

const PDF = 'SGVsbG8gd29ybGQ=' // base64 "Hello world"

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

function specFrom(fields: Record<string, unknown>): TermsOfUseSpec {
  return extractTermsOfUseSpecs({ items: [{ fields }] } as unknown as CanvasSnapshot)[0]
}

describe('terms-of-use-agreements validate', () => {
  it('accepts a valid agreement', () => {
    const r = validate(ctxWith([{ fields: { name: 'Guest ToU', fileData: PDF } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ fields: { fileData: PDF } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires base64 PDF content', () => {
    const r = validate(ctxWith([{ fields: { name: 'No file' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'file_required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { fields: { name: 'Dup', fileData: PDF } },
        { fields: { name: 'Dup', fileData: PDF } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid re-accept duration', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', fileData: PDF, reacceptFrequency: '365 days' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_duration')).toBe(true)
  })

  it('accepts a valid ISO 8601 re-accept duration', () => {
    const r = validate(ctxWith([{ fields: { name: 'X', fileData: PDF, reacceptFrequency: 'P365D' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an expiration missing its frequency', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', fileData: PDF, expirationStartDate: '2026-01-01T00:00:00Z' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'incomplete_expiration')).toBe(true)
  })

  it('accepts a complete expiration pair', () => {
    const r = validate(
      ctxWith([
        {
          fields: {
            name: 'X',
            fileData: PDF,
            expirationStartDate: '2026-01-01T00:00:00Z',
            expirationFrequency: 'P365D',
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
  })

  it('rejects a bad expiration start date-time', () => {
    const r = validate(
      ctxWith([{ fields: { name: 'X', fileData: PDF, expirationStartDate: 'Jan 1 2026', expirationFrequency: 'P365D' } }]),
    )
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_datetime')).toBe(true)
  })
})

describe('helpers', () => {
  it('defaults file name and language', () => {
    const spec = specFrom({ name: 'X', fileData: PDF })
    expect(effectiveFileName(spec)).toBe('agreement.pdf')
    expect(effectiveLanguage(spec)).toBe('en')
  })

  it('builds termsExpiration only when both parts are present', () => {
    expect(buildTermsExpiration(specFrom({ name: 'X', fileData: PDF }))).toBeUndefined()
    expect(
      buildTermsExpiration(
        specFrom({ name: 'X', fileData: PDF, expirationStartDate: '2026-01-01T00:00:00Z', expirationFrequency: 'P365D' }),
      ),
    ).toEqual({ startDateTime: '2026-01-01T00:00:00Z', frequency: 'P365D' })
  })
})

describe('deploy body shape', () => {
  it('wraps the PDF in a files array with base64 fileData and sets metadata', () => {
    const spec = specFrom({
      name: 'Guest ToU',
      fileData: PDF,
      perDeviceAcceptanceRequired: true,
      reacceptFrequency: 'P365D',
      expirationStartDate: '2026-01-01T00:00:00Z',
      expirationFrequency: 'P365D',
    })
    const body = buildCreateBody(spec) as Record<string, unknown>
    const files = body.files as Array<Record<string, unknown>>
    expect(files).toHaveLength(1)
    expect((files[0].fileData as Record<string, unknown>).data).toBe(PDF)
    expect(files[0].fileName).toBe('agreement.pdf')
    expect(files[0].language).toBe('en')
    expect(files[0].isDefault).toBe(true)
    expect(body.isPerDeviceAcceptanceRequired).toBe(true)
    expect(body.userReacceptRequiredFrequency).toBe('P365D')
    expect(body.termsExpiration).toEqual({ startDateTime: '2026-01-01T00:00:00Z', frequency: 'P365D' })
  })

  it('PATCH body carries ONLY the two update-supported fields', () => {
    const spec = specFrom({ name: 'Renamed', fileData: PDF, viewingBeforeAcceptanceRequired: true, perDeviceAcceptanceRequired: true })
    const body = buildPatchBody(spec) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['displayName', 'isViewingBeforeAcceptanceRequired'])
    expect(body.displayName).toBe('Renamed')
    expect(body.isViewingBeforeAcceptanceRequired).toBe(true)
  })
})
