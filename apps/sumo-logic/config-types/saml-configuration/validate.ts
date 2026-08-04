import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { normalizeBool } from './_shared'

const PEM_RE = /-----BEGIN CERTIFICATE-----/

/**
 * Validate SAML configuration items: a non-empty configuration name, issuer
 * and signing certificate, and the fields required by whichever optional
 * behaviors are turned on (SP-initiated login needs an authn request URL,
 * on-demand provisioning needs first/last name attributes, logout redirect
 * needs a logout URL). Static — no target access required. ALWAYS warns that
 * this configures organization-wide sign-in, since a mistake here can lock out
 * SSO-only users.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one SAML configuration.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const configurationName = String(item.fields.configurationName ?? '').trim()
    const issuer = String(item.fields.issuer ?? '').trim()
    const cert = String(item.fields.x509cert1 ?? '').trim()

    if (!configurationName) {
      errors.push({ field: `items[${i}].configurationName`, message: 'Configuration name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = configurationName.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].configurationName`,
          message: `Configuration name "${configurationName}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!issuer) {
      errors.push({ field: `items[${i}].issuer`, message: 'Issuer is required.', code: 'EMPTY_ISSUER' })
    }

    if (!cert) {
      errors.push({ field: `items[${i}].x509cert1`, message: 'Signing certificate is required.', code: 'EMPTY_CERTIFICATE' })
    } else if (!PEM_RE.test(cert)) {
      warnings.push({
        field: `items[${i}].x509cert1`,
        message: 'Signing certificate does not look like a PEM-encoded certificate (missing "-----BEGIN CERTIFICATE-----"). Verify it was pasted correctly.',
        code: 'CERTIFICATE_NOT_PEM',
      })
    }

    if (normalizeBool(item.fields.spInitiatedLoginEnabled) && !String(item.fields.authnRequestUrl ?? '').trim()) {
      errors.push({
        field: `items[${i}].authnRequestUrl`,
        message: 'Authn Request URL is required when SP-Initiated Login is on.',
        code: 'EMPTY_AUTHN_REQUEST_URL',
      })
    }

    if (normalizeBool(item.fields.onDemandProvisioningEnabled)) {
      if (!String(item.fields.onDemandFirstNameAttribute ?? '').trim()) {
        errors.push({
          field: `items[${i}].onDemandFirstNameAttribute`,
          message: 'First Name Attribute is required when On-Demand User Provisioning is on.',
          code: 'EMPTY_FIRST_NAME_ATTRIBUTE',
        })
      }
      if (!String(item.fields.onDemandLastNameAttribute ?? '').trim()) {
        errors.push({
          field: `items[${i}].onDemandLastNameAttribute`,
          message: 'Last Name Attribute is required when On-Demand User Provisioning is on.',
          code: 'EMPTY_LAST_NAME_ATTRIBUTE',
        })
      }
    }

    if (normalizeBool(item.fields.logoutEnabled) && !String(item.fields.logoutUrl ?? '').trim()) {
      errors.push({ field: `items[${i}].logoutUrl`, message: 'Logout URL is required when Redirect on Logout is on.', code: 'EMPTY_LOGOUT_URL' })
    }

    warnings.push({
      field: `items[${i}].configurationName`,
      message: `"${configurationName || i}" configures organization-wide SSO sign-in — an incorrect issuer, certificate or URL can lock out every SSO-only user. Verify against the identity provider before deploying.`,
      code: 'HIGH_BLAST_RADIUS',
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
