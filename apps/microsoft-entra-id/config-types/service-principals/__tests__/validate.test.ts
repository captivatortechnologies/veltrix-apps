import validate, {
  effectiveSsoMode,
  extractServicePrincipalSpecs,
  findByAppIdPath,
  normalizeList,
} from '../validate'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

const GUID = '11111111-1111-1111-1111-111111111111'
const GUID_2 = '22222222-2222-2222-2222-222222222222'

function ctxWith(
  items: Array<{ id?: string; name?: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('service-principals validate', () => {
  it('accepts a valid service principal', () => {
    const r = validate(ctxWith([{ fields: { appId: GUID, preferredSingleSignOnMode: 'saml' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an appId', () => {
    const r = validate(ctxWith([{ fields: { accountEnabled: true } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-GUID appId', () => {
    const r = validate(ctxWith([{ fields: { appId: 'not-a-guid' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_guid')).toBe(true)
  })

  it('rejects duplicate appIds', () => {
    const r = validate(
      ctxWith([{ fields: { appId: GUID } }, { fields: { appId: GUID } }])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_app_id')).toBe(true)
  })

  it('rejects an unrecognized single sign-on mode', () => {
    const r = validate(ctxWith([{ fields: { appId: GUID, preferredSingleSignOnMode: 'kerberos' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_sso_mode')).toBe(true)
  })

  it('accepts each supported single sign-on mode', () => {
    for (const mode of ['saml', 'password', 'oidc', 'notSupported']) {
      const r = validate(ctxWith([{ fields: { appId: GUID, preferredSingleSignOnMode: mode } }]))
      expect(r.valid).toBe(true)
    }
  })

  it('rejects an invalid notification email address', () => {
    const r = validate(ctxWith([{ fields: { appId: GUID, notificationEmailAddresses: 'bad-address' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_email')).toBe(true)
  })
})

describe('extractServicePrincipalSpecs', () => {
  it('defaults accountEnabled to true and appRoleAssignmentRequired to false when unset', () => {
    const specs = extractServicePrincipalSpecs({ items: [{ fields: { appId: GUID } }] } as unknown as CanvasSnapshot)
    expect(specs[0].accountEnabled).toBe(true)
    expect(specs[0].appRoleAssignmentRequired).toBe(false)
  })

  it('honors an explicit accountEnabled false', () => {
    const specs = extractServicePrincipalSpecs({
      items: [{ fields: { appId: GUID, accountEnabled: false } }],
    } as unknown as CanvasSnapshot)
    expect(specs[0].accountEnabled).toBe(false)
  })

  it('splits tags and emails on newlines and commas', () => {
    const specs = extractServicePrincipalSpecs({
      items: [{ fields: { appId: GUID, tags: 'a, b\nc', notificationEmailAddresses: 'x@e.com\ny@e.com' } }],
    } as unknown as CanvasSnapshot)
    expect(specs[0].tags).toEqual(['a', 'b', 'c'])
    expect(specs[0].notificationEmailAddresses).toEqual(['x@e.com', 'y@e.com'])
  })
})

describe('effectiveSsoMode', () => {
  it('returns a recognized mode and blanks an unknown one', () => {
    expect(effectiveSsoMode({ preferredSingleSignOnMode: 'saml' })).toBe('saml')
    expect(effectiveSsoMode({ preferredSingleSignOnMode: 'nope' })).toBe('')
    expect(effectiveSsoMode({ preferredSingleSignOnMode: '' })).toBe('')
  })
})

describe('normalizeList', () => {
  it('is order-insensitive and drops blanks', () => {
    expect(normalizeList(['b', 'a', '  '])).toBe(normalizeList(['a', 'b']))
  })
})

describe('findByAppIdPath', () => {
  it('builds an appId-filtered, encoded select path', () => {
    const path = findByAppIdPath(GUID_2)
    expect(path).toContain('/servicePrincipals?$filter=')
    expect(path).toContain(encodeURIComponent(`appId eq '${GUID_2}'`))
    expect(path).toContain('$select=')
  })
})
