import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Akeyless Gateway K8s Auth Config API constraints ---------------------------
// https://docs.akeyless.io
//   POST /gateway-create-k8s-auth-config, /gateway-update-k8s-auth-config,
//   /gateway-delete-k8s-auth-config, /gateway-get-k8s-auth-config
// Identity is the config's NAME. Unlike most secrets in this app,
// "signing-key" is REQUIRED on every create AND update call (confirmed from
// the OpenAPI spec) - see canvas.yaml header.

export interface K8sAuthConfigSpec {
  sectionName: string
  name: string
  accessId: string
  signingKey: string
  tokenExp: string
  k8sHost: string
  k8sCaCert: string
  tokenReviewerJwt: string
  k8sIssuer: string
  disableIssuerValidation: boolean
  clusterApiType: string
  rancherApiKey: string
  rancherClusterId: string
  useLocalCaJwt: boolean
  k8sAuthType: string
  k8sClientCertificate: string
  k8sClientKey: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function bool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Each canvas item describes one Akeyless Gateway K8s auth config. */
export function extractK8sAuthConfigSpecs(canvas: CanvasSnapshot): K8sAuthConfigSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = (section.fields ?? {}) as Record<string, unknown>
    return {
      sectionName: section.name,
      name: str(f.name),
      accessId: str(f.accessId),
      signingKey: str(f.signingKey),
      tokenExp: str(f.tokenExp) || '300',
      k8sHost: str(f.k8sHost),
      k8sCaCert: str(f.k8sCaCert),
      tokenReviewerJwt: str(f.tokenReviewerJwt),
      k8sIssuer: str(f.k8sIssuer) || 'kubernetes/serviceaccount',
      disableIssuerValidation: bool(f.disableIssuerValidation),
      clusterApiType: str(f.clusterApiType) || 'native_k8s',
      rancherApiKey: str(f.rancherApiKey),
      rancherClusterId: str(f.rancherClusterId),
      useLocalCaJwt: bool(f.useLocalCaJwt),
      k8sAuthType: str(f.k8sAuthType) || 'token',
      k8sClientCertificate: str(f.k8sClientCertificate),
      k8sClientKey: str(f.k8sClientKey),
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractK8sAuthConfigSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (seenNames.has(spec.name)) {
      errors.push({ field: `${prefix}.name`, message: `Duplicate K8s auth config "${spec.name}"`, code: 'duplicate_name' })
    }
    if (spec.name) seenNames.add(spec.name)

    if (!spec.accessId) {
      errors.push({ field: `${prefix}.accessId`, message: 'Kubernetes Auth Method is required', code: 'required' })
    }
    if (!spec.signingKey) {
      errors.push({ field: `${prefix}.signingKey`, message: 'Signing Key is required on every deploy for this config type (see canvas help text)', code: 'required' })
    }
    if (!spec.k8sHost) {
      errors.push({ field: `${prefix}.k8sHost`, message: 'Kubernetes API Server URL is required', code: 'required' })
    }
    if (!['native_k8s', 'rancher'].includes(spec.clusterApiType)) {
      errors.push({ field: `${prefix}.clusterApiType`, message: 'Cluster Access Type must be "native_k8s" or "rancher"', code: 'invalid_value' })
    }
    if (!['token', 'certificate'].includes(spec.k8sAuthType)) {
      errors.push({ field: `${prefix}.k8sAuthType`, message: 'K8s Auth Type must be "token" or "certificate"', code: 'invalid_value' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
