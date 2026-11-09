import type { ActionClass, ActionSpec } from './types'
import { classifyActionType, isDeleteFamily } from './awsResources'
import { isRecord } from './issues'

const RANK: Record<ActionClass, number> = {
  none: 0,
  reversible: 1,
  'snapshot-delete': 2,
  irreversible: 3,
}

export function actionTypeOf(spec: unknown): string | null {
  if (typeof spec === 'string') return spec.length > 0 ? spec : null
  if (isRecord(spec) && typeof spec.type === 'string' && spec.type.length > 0) return spec.type
  return null
}

function hasSnapshotFlag(spec: unknown): boolean {
  if (!isRecord(spec)) return false
  return Object.entries(spec).some(([key, value]) => {
    if (!/snapshot/i.test(key)) return false
    return /^skip/i.test(key) ? value === false : Boolean(value)
  })
}

export function maxActionClass(classes: readonly ActionClass[]): ActionClass {
  return classes.reduce<ActionClass>((acc, cls) => (RANK[cls] > RANK[acc] ? cls : acc), 'none')
}

export function classifyActions(actions: readonly ActionSpec[]): ActionClass {
  const types = actions.map(actionTypeOf)
  const classes = types.map((type, index): ActionClass => {
    if (type === null) return 'none'
    const base = classifyActionType(type)
    if (base === null) return 'none'
    if (base === 'irreversible' && isDeleteFamily(type)) {
      const snapshotBefore = types.slice(0, index).includes('snapshot')
      if (snapshotBefore || hasSnapshotFlag(actions[index])) return 'snapshot-delete'
    }
    return base
  })
  return maxActionClass(classes)
}
