import validate, { extractNotificationTemplateSpecs, compositeKey } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('notification-templates validate', () => {
  it('accepts a valid template', () => {
    const r = validate(ctxWith([{ name: 'k', fields: { key: 'welcome', medium: 'EMAIL', locale: 'en', subject: 'Hi', body: 'Welcome' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a key', () => {
    const r = validate(ctxWith([{ name: '', fields: { medium: 'EMAIL' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].key')).toBe(true)
  })

  it('rejects an invalid medium', () => {
    const r = validate(ctxWith([{ name: 'k', fields: { key: 'k', medium: 'CARRIER_PIGEON' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects duplicate key+medium+locale', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { key: 'k', medium: 'EMAIL', locale: 'en', body: 'x' } },
        { name: 'b', fields: { key: 'k', medium: 'EMAIL', locale: 'en', body: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_key')).toBe(true)
  })
})

describe('extractNotificationTemplateSpecs / compositeKey', () => {
  it('defaults medium and locale and builds a composite key', () => {
    const specs = extractNotificationTemplateSpecs({
      items: [{ id: 'i1', name: 'k', fields: { key: 'welcome' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].medium).toBe('EMAIL')
    expect(specs[0].locale).toBe('en')
    expect(compositeKey('welcome', 'EMAIL', 'en')).toBe('welcome::EMAIL::en')
  })
})
