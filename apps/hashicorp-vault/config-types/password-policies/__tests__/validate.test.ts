import validate, {
  checkPasswordPolicyHcl,
  extractPasswordPolicySpecs,
  normalizePasswordPolicy,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'hashicorp-vault',
    customerId: 'cust-1',
    configTypeId: 'password-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'hashicorp-vault',
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

const VALID_HCL =
  'length = 20\n\nrule "charset" {\n  charset = "abcdefghijklmnopqrstuvwxyz"\n  min-chars = 1\n}'

describe('Vault Password Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid password policy', async () => {
    const result = await validate(
      makeCtx([{ name: 'Policy', fields: { name: 'db-password', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a policy with multiple charset rules', async () => {
    const multi =
      'length = 24\nrule "charset" { charset = "abcdefghijklmnopqrstuvwxyz" min-chars = 1 }\n' +
      'rule "charset" { charset = "0123456789" min-chars = 1 }'
    const result = await validate(makeCtx([{ name: 'Policy', fields: { name: 'complex', policy: multi } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { policy: VALID_HCL } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing policy body', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'db-password' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policy'))).toBe(true)
  })

  it('rejects a name with invalid characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'bad name!', policy: VALID_HCL } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects HCL with unbalanced braces', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'db-password', policy: 'length = 20\nrule "charset" {' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'unbalanced_braces')).toBe(true)
  })

  it('rejects HCL with no length declaration', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'db-password', policy: 'rule "charset" { charset = "abc" min-chars = 1 }' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_length')).toBe(true)
  })

  it('rejects HCL with no charset rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'db-password', policy: 'length = 20' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'missing_charset_rule')).toBe(true)
  })

  it('rejects a duplicate policy name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'db-password', policy: VALID_HCL } },
        { name: 'sec2', fields: { name: 'db-password', policy: VALID_HCL } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('treats different-cased names as distinct (Vault stores the name verbatim)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'DbPassword', policy: VALID_HCL } },
        { name: 'sec2', fields: { name: 'dbpassword', policy: VALID_HCL } },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('allows two distinct policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'db-password', policy: VALID_HCL } },
        { name: 'sec2', fields: { name: 'api-password', policy: VALID_HCL } },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractPasswordPolicySpecs', () => {
  it('trims the name and the policy without folding case', () => {
    const specs = extractPasswordPolicySpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'hashicorp-vault',
      entityType: 'password-policies',
      items: [],
      sections: [{ name: 'sec1', fields: { name: '  DbPassword  ', policy: `  ${VALID_HCL}  ` } }],
      snapshot: {},
    })
    expect(specs[0].name).toBe('DbPassword')
    expect(specs[0].policy).toBe(VALID_HCL)
  })
})

describe('checkPasswordPolicyHcl', () => {
  it('accepts a well-formed policy', () => {
    expect(checkPasswordPolicyHcl(VALID_HCL).ok).toBe(true)
  })
  it('rejects an empty body', () => {
    const res = checkPasswordPolicyHcl('   ')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('empty')
  })
  it('rejects unbalanced braces', () => {
    const res = checkPasswordPolicyHcl('length = 20\nrule "charset" {')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unbalanced_braces')
  })
  it('rejects a closing brace before its opener', () => {
    const res = checkPasswordPolicyHcl('} length = 20 rule "charset" {')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unbalanced_braces')
  })
  it('rejects a body with no length declaration', () => {
    const res = checkPasswordPolicyHcl('rule "charset" { charset = "abc" min-chars = 1 }')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('missing_length')
  })
  it('rejects a body with no charset rule', () => {
    const res = checkPasswordPolicyHcl('length = 20')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('missing_charset_rule')
  })
  it('does not mistake a substring like maxlength for a length declaration', () => {
    const res = checkPasswordPolicyHcl('maxlength = 20\nrule "charset" { charset = "abc" }')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('missing_length')
  })
})

describe('normalizePasswordPolicy', () => {
  it('treats whitespace/newline-only reformats as equal', () => {
    const a = 'length = 20\nrule "charset" {\n  charset = "abc"\n  min-chars = 1\n}'
    const b = 'length = 20   rule "charset" {  charset = "abc"   min-chars = 1  }'
    expect(normalizePasswordPolicy(a)).toBe(normalizePasswordPolicy(b))
  })
  it('reports drift when the length differs', () => {
    const twenty = 'length = 20 rule "charset" { charset = "abc" }'
    const thirty = 'length = 30 rule "charset" { charset = "abc" }'
    expect(normalizePasswordPolicy(twenty) === normalizePasswordPolicy(thirty)).toBe(false)
  })
  it('preserves a "#" inside a charset (comments are not stripped)', () => {
    const withHash = 'length = 20 rule "charset" { charset = "abc#def" min-chars = 1 }'
    expect(normalizePasswordPolicy(withHash)).toContain('abc#def')
  })
})
