import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, stableStringify } from '../../lib/akeyless'
import { getAuthMethod, mapAccessInfoToSpec } from './deploy'
import { extractAuthMethodSpecs, detectLiveAuthMethodType, type AuthMethodSpec } from './validate'

/**
 * Which fields are compared for drift, per type. Excludes
 * `sectionName`/`name`/`type` (identity, checked separately) and
 * `clientSecret` (write-only - Akeyless never returns it, so it can never
 * be diffed; see canvas.yaml). Scoped per type so drift reports only
 * mention fields relevant to the declared auth-method type.
 */
function relevantKeys(type: AuthMethodSpec['type']): (keyof AuthMethodSpec)[] {
  const common: (keyof AuthMethodSpec)[] = [
    'description',
    'accessExpires',
    'boundIps',
    'gwBoundIps',
    'forceSubClaims',
    'jwtTtl',
    'allowedClientType',
    'productType',
    'auditLogsClaims',
    'deleteProtection',
  ]
  const byType: Record<string, (keyof AuthMethodSpec)[]> = {
    'api-key': [],
    'aws-iam': [
      'boundAwsAccountId',
      'stsUrl',
      'boundArn',
      'boundRoleName',
      'boundRoleId',
      'boundResourceId',
      'boundUserName',
      'boundUserId',
      'uniqueIdentifierAwsIam',
    ],
    'azure-ad': [
      'boundTenantId',
      'issuerAzureAd',
      'jwksUri',
      'audienceAzureAd',
      'boundSpid',
      'boundGroupId',
      'boundSubId',
      'boundRgId',
      'boundProviders',
      'boundResourceTypes',
      'boundResourceNames',
      'boundResourceIdAzureAd',
      'uniqueIdentifierAzureAd',
    ],
    k8s: ['audienceK8s', 'boundSaNames', 'boundPodNames', 'boundNamespaces', 'publicKey'],
    oidc: [
      'issuerOidc',
      'clientId',
      'uniqueIdentifierOidc',
      'allowedRedirectUri',
      'requiredScopes',
      'requiredScopesPrefix',
      'audienceOidc',
      'subclaimsDelimiters',
    ],
  }
  return [...common, ...(byType[type] ?? [])]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractAuthMethodSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)

  for (const spec of specs) {
    let live
    try {
      live = await getAuthMethod(client, spec.name)
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
      continue
    }

    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveType = detectLiveAuthMethodType(live.access_info)
    if (liveType !== 'unknown' && liveType !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType, severity: 'critical' })
      continue
    }

    const liveSpec = mapAccessInfoToSpec(spec, live)
    for (const key of relevantKeys(spec.type)) {
      const expected = stableStringify(spec[key])
      const actual = stableStringify(liveSpec[key])
      if (expected !== actual) {
        diffs.push({
          field: `${spec.name}.${key}`,
          expected: describeValue(spec[key]),
          actual: describeValue(liveSpec[key]),
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (value === '' || value === undefined || value === null) return '(none)'
  return String(value)
}
