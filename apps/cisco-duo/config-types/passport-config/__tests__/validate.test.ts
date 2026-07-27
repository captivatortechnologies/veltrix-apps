import validate, { extractPassportSpecs, parseList, normalizeGroupIds } from '../validate'
import { buildPassportBody, normalizeLive } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('passport-config validate', () => {
  it('accepts a valid enabled-for-groups config', () => {
    const r = validate(
      ctxWith([{ name: 'Passport', fields: { enabled_status: 'enabled-for-groups', enabled_groups: 'DG1\nDG2' } }])
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an enabled status', () => {
    const r = validate(ctxWith([{ name: 'Passport', fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid enabled status', () => {
    const r = validate(ctxWith([{ name: 'Passport', fields: { enabled_status: 'sometimes' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_status')).toBe(true)
  })

  it('rejects more than one configuration (singleton)', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { enabled_status: 'disabled' } },
        { name: 'b', fields: { enabled_status: 'enabled' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'singleton')).toBe(true)
  })

  it('warns when enabled-for-groups has no groups', () => {
    const r = validate(ctxWith([{ name: 'Passport', fields: { enabled_status: 'enabled-for-groups' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_groups')).toBe(true)
  })
})

describe('parseList', () => {
  it('splits, trims and dedupes newline/comma lists', () => {
    expect(parseList(' A , B\nA \n C ')).toEqual(['A', 'B', 'C'])
    expect(parseList('')).toEqual([])
  })
})

describe('normalizeGroupIds', () => {
  it('reads ids from group objects and strings', () => {
    expect(normalizeGroupIds([{ group_id: 'DG1', group_name: 'x' }, 'DG2'])).toEqual(['DG1', 'DG2'])
  })
})

describe('buildPassportBody / normalizeLive', () => {
  it('builds a POST body from a spec', () => {
    const body = buildPassportBody({
      sectionName: 's',
      enabledStatus: 'enabled',
      enabledGroups: ['DG1'],
      disabledGroups: [],
      customBrowsersMacos: [],
      customBrowsersWindows: ['Edge'],
    })
    expect(body).toEqual({
      enabled_status: 'enabled',
      enabled_groups: ['DG1'],
      disabled_groups: [],
      custom_supported_browsers: { macos: [], windows: ['Edge'] },
    })
  })

  it('normalizes a live response into a POST-shaped body', () => {
    expect(
      normalizeLive({ enabled_status: 'enabled-for-groups', enabled_groups: [{ group_id: 'DG1' }] })
    ).toEqual({
      enabled_status: 'enabled-for-groups',
      enabled_groups: ['DG1'],
      disabled_groups: [],
      custom_supported_browsers: { macos: [], windows: [] },
    })
  })
})
