import validate, {
  canonicalAppRoles,
  canonicalRequiredResourceAccess,
  canonicalStringList,
  effectiveUniqueName,
  isValidUri,
  parseJsonArray,
  slugifyUniqueName,
} from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('applications validate', () => {
  it('accepts a minimal valid app', () => {
    const r = validate(ctxWith([{ name: 'Payments API', fields: { name: 'Payments API' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a full valid app with JSON roles, permissions and redirect URIs', () => {
    const r = validate(
      ctxWith([
        {
          name: 'Web App',
          fields: {
            name: 'Web App',
            signInAudience: 'AzureADMultipleOrgs',
            redirectUris: 'https://contoso.com/callback\nhttps://contoso.com/signin',
            spaRedirectUris: 'https://spa.contoso.com/',
            identifierUris: 'api://web-app',
            groupMembershipClaims: 'SecurityGroup',
            tags: 'prod\nteam-auth',
            appRoles:
              '[{"id":"18d14569-c3bd-439b-9a66-3a2aee01d14f","allowedMemberTypes":["User"],"displayName":"Admin","description":"Admins","value":"Admin","isEnabled":true}]',
            requiredResourceAccess:
              '[{"resourceAppId":"00000003-0000-0000-c000-000000000000","resourceAccess":[{"id":"e1fe6dd8-ba31-4d61-89e7-88639da4683d","type":"Scope"}]}]',
          },
        },
      ]),
    )
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a display name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate display names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects an invalid sign-in audience', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', signInAudience: 'Everyone' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects an invalid group membership claim', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', groupMembershipClaims: 'Some' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects appRoles that are not a JSON array', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', appRoles: '{"id":"x"}' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects appRoles whose element is not an object', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', appRoles: '["nope"]' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects requiredResourceAccess that is not valid JSON', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', requiredResourceAccess: '[not json' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an invalid redirect URI', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', redirectUris: 'not a uri' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_uri')).toBe(true)
  })

  it('rejects an invalid explicit unique name', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', uniqueName: 'has spaces' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_unique_name')).toBe(true)
  })

  it('rejects a name that cannot derive a unique name', () => {
    const r = validate(ctxWith([{ name: '***', fields: { name: '***' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_unique_name')).toBe(true)
  })

  it('rejects duplicate unique names', () => {
    const r = validate(
      ctxWith([
        { name: 'App One', fields: { name: 'App One', uniqueName: 'shared' } },
        { name: 'App Two', fields: { name: 'App Two', uniqueName: 'shared' } },
      ]),
    )
    expect(r.errors.some((e) => e.code === 'duplicate_unique_name')).toBe(true)
  })
})

describe('slugifyUniqueName / effectiveUniqueName', () => {
  it('slugifies a display name into a valid unique name', () => {
    expect(slugifyUniqueName('Payments API')).toBe('Payments-API')
    expect(slugifyUniqueName('  Corp / IT  ')).toBe('Corp-IT')
    expect(slugifyUniqueName('***')).toBe('')
  })

  it('prefers an explicit unique name, else derives from the name', () => {
    expect(
      effectiveUniqueName({
        name: 'Payments API',
        uniqueName: '',
        signInAudience: 'AzureADMyOrg',
        redirectUris: [],
        spaRedirectUris: [],
        identifierUris: [],
        appRoles: '',
        requiredResourceAccess: '',
        groupMembershipClaims: '',
        tags: [],
      }),
    ).toBe('Payments-API')
    expect(
      effectiveUniqueName({
        name: 'Payments API',
        uniqueName: 'explicit-key',
        signInAudience: 'AzureADMyOrg',
        redirectUris: [],
        spaRedirectUris: [],
        identifierUris: [],
        appRoles: '',
        requiredResourceAccess: '',
        groupMembershipClaims: '',
        tags: [],
      }),
    ).toBe('explicit-key')
  })
})

describe('canonicalization helpers', () => {
  it('treats a blank JSON array as empty', () => {
    expect(parseJsonArray('')).toEqual([])
  })

  it('rejects a JSON object as an array', () => {
    expect(parseJsonArray('{"a":1}')).toBe(null)
  })

  it('canonicalizes string lists regardless of order or duplicates', () => {
    expect(canonicalStringList(['b', 'a', 'b'])).toBe(canonicalStringList(['a', 'b']))
  })

  it('ignores read-only origin and role order for appRoles', () => {
    const withOrigin = canonicalAppRoles([
      { id: '2', value: 'B', allowedMemberTypes: ['User'] },
      { id: '1', value: 'A', allowedMemberTypes: ['Application', 'User'], origin: 'Application' },
    ])
    const clean = canonicalAppRoles([
      { id: '1', value: 'A', allowedMemberTypes: ['User', 'Application'] },
      { id: '2', value: 'B', allowedMemberTypes: ['User'] },
    ])
    expect(withOrigin).toBe(clean)
  })

  it('canonicalizes requiredResourceAccess independent of order', () => {
    const a = canonicalRequiredResourceAccess([
      {
        resourceAppId: 'r1',
        resourceAccess: [
          { id: 'p2', type: 'Role' },
          { id: 'p1', type: 'Scope' },
        ],
      },
    ])
    const b = canonicalRequiredResourceAccess([
      {
        resourceAppId: 'r1',
        resourceAccess: [
          { id: 'p1', type: 'Scope' },
          { id: 'p2', type: 'Role' },
        ],
      },
    ])
    expect(a).toBe(b)
  })

  it('validates absolute URIs', () => {
    expect(isValidUri('https://contoso.com/callback')).toBe(true)
    expect(isValidUri('api://web-app')).toBe(true)
    expect(isValidUri('not a uri')).toBe(false)
  })
})
