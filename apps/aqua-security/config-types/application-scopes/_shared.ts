// =============================================================================
// Shared spec/validation/wire-format helpers for the Aqua Security
// application-scopes config type (validate + deploy + rollback + drift).
// Mirrors client.ApplicationScope / client.Category / client.CommonStruct
// (client/application_scope.go) — see lib/aquasec.ts's module doc for the
// endpoint citation, and canvas.yaml's module doc for the deliberately
// scoped-down category subset (image / Kubernetes workloads / Kubernetes
// infrastructure).
// =============================================================================

import type { CanvasSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import type { AquaApplicationScope, AquaScopeCategory } from '../../lib/aquasec'
import { buildScope, displayScope, sameScope } from '../lib/common'

export interface ApplicationScopeSpec {
  itemId?: string
  name: string
  description: string
  ownerEmail: string
  imageExpression: string
  imageVariables: unknown
  kubernetesWorkloadExpression: string
  kubernetesWorkloadVariables: unknown
  kubernetesInfraExpression: string
  kubernetesInfraVariables: unknown
}

export function extractApplicationScopeSpecs(canvas: CanvasSnapshot): ApplicationScopeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(f.name ?? '').trim(),
      description: String(f.description ?? '').trim(),
      ownerEmail: String(f.ownerEmail ?? '').trim(),
      imageExpression: String(f.imageExpression ?? '').trim(),
      imageVariables: f.imageVariables,
      kubernetesWorkloadExpression: String(f.kubernetesWorkloadExpression ?? '').trim(),
      kubernetesWorkloadVariables: f.kubernetesWorkloadVariables,
      kubernetesInfraExpression: String(f.kubernetesInfraExpression ?? '').trim(),
      kubernetesInfraVariables: f.kubernetesInfraVariables,
    }
  })
}

function toCategory(expression: string, variables: unknown): AquaScopeCategory | undefined {
  const scope = buildScope(expression, variables)
  return scope
}

export function buildApplicationScopeBody(spec: ApplicationScopeSpec): AquaApplicationScope {
  const image = toCategory(spec.imageExpression, spec.imageVariables)
  const kubernetesWorkload = toCategory(spec.kubernetesWorkloadExpression, spec.kubernetesWorkloadVariables)
  const kubernetesInfra = toCategory(spec.kubernetesInfraExpression, spec.kubernetesInfraVariables)

  return {
    name: spec.name,
    description: spec.description,
    owner_email: spec.ownerEmail || undefined,
    categories: {
      artifacts: image ? { image } : undefined,
      workloads: kubernetesWorkload ? { kubernetes: kubernetesWorkload } : undefined,
      infrastructure: kubernetesInfra ? { kubernetes: kubernetesInfra } : undefined,
    },
  }
}

export function diffApplicationScope(spec: ApplicationScopeSpec, live: AquaApplicationScope): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const push = (field: string, expected: unknown, actual: unknown, severity: DriftDiff['severity'] = 'warning') => {
    diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity })
  }

  if ((spec.description || '') !== (live.description || '')) push('description', spec.description, live.description ?? '')

  const declaredImage = toCategory(spec.imageExpression, spec.imageVariables)
  if (!sameScope(declaredImage, live.categories?.artifacts?.image)) {
    push('imageScope', displayScope(declaredImage), displayScope(live.categories?.artifacts?.image), 'critical')
  }

  const declaredWorkload = toCategory(spec.kubernetesWorkloadExpression, spec.kubernetesWorkloadVariables)
  if (!sameScope(declaredWorkload, live.categories?.workloads?.kubernetes)) {
    push('kubernetesWorkloadScope', displayScope(declaredWorkload), displayScope(live.categories?.workloads?.kubernetes), 'critical')
  }

  const declaredInfra = toCategory(spec.kubernetesInfraExpression, spec.kubernetesInfraVariables)
  if (!sameScope(declaredInfra, live.categories?.infrastructure?.kubernetes)) {
    push('kubernetesInfraScope', displayScope(declaredInfra), displayScope(live.categories?.infrastructure?.kubernetes), 'critical')
  }

  return diffs
}
