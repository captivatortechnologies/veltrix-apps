// Shared helpers for the Greenbone Alerts config type (deploy + rollback +
// drift). An alert fires a METHOD when a CONDITION on an EVENT is met. Applied
// over GMP (XML over TLS). The alert NAME is the stable identity used to
// upsert — gvmd does not enforce unique names, so this app treats the name as
// the key (last one wins).
//
// FLAG: scoped to secret-free methods only (Email/HTTP Get/Syslog/Start Task/
// SNMP) — see lib/gmp/alerts.ts's module doc for why SCP/SMB/TippingPoint
// SMS/verinice Connector are excluded.

import type { AlertClause, AlertInput } from '../../lib/gmp/alerts'
import type { GmpAlert } from '../../lib/gmp/alerts'

/** Build the event clause's data from the flat canvas fields relevant to the selected event. */
function eventClause(fields: Record<string, unknown>): AlertClause {
  const event = String(fields.event ?? '').trim() || 'Task run status changed'
  const data = event === 'Task run status changed' && fields.eventStatus ? [{ name: 'status', value: String(fields.eventStatus).trim() }] : []
  return { value: event, data }
}

/** Build the condition clause's data from the flat canvas fields relevant to the selected condition. */
function conditionClause(fields: Record<string, unknown>): AlertClause {
  const condition = String(fields.condition ?? '').trim() || 'Always'
  const data: Array<{ name: string; value: string }> = []
  if (condition === 'Severity at least' && fields.conditionSeverity !== undefined && fields.conditionSeverity !== '') {
    data.push({ name: 'severity', value: String(fields.conditionSeverity) })
  }
  if ((condition === 'Filter count at least' || condition === 'Filter count changed') && fields.conditionFilterId) {
    data.push({ name: 'filter_id', value: String(fields.conditionFilterId).trim() })
  }
  if (condition === 'Filter count at least' && fields.conditionFilterCount !== undefined && fields.conditionFilterCount !== '') {
    data.push({ name: 'count', value: String(fields.conditionFilterCount) })
  }
  return { value: condition, data }
}

/** Build the method clause's data from the flat canvas fields relevant to the selected method (secret-free only, see FLAG). */
function methodClause(fields: Record<string, unknown>): AlertClause {
  const method = String(fields.method ?? '').trim() || 'Email'
  const data: Array<{ name: string; value: string }> = []
  switch (method) {
    case 'Email':
      if (fields.emailTo) data.push({ name: 'to_address', value: String(fields.emailTo).trim() })
      if (fields.emailFrom) data.push({ name: 'from_address', value: String(fields.emailFrom).trim() })
      if (fields.emailSubject) data.push({ name: 'subject', value: String(fields.emailSubject).trim() })
      if (fields.emailBody) data.push({ name: 'message', value: String(fields.emailBody).trim() })
      break
    case 'HTTP Get':
      if (fields.httpUrl) data.push({ name: 'URL', value: String(fields.httpUrl).trim() })
      break
    case 'Start Task':
      if (fields.startTaskId) data.push({ name: 'start_task_task', value: String(fields.startTaskId).trim() })
      break
    case 'SNMP':
      if (fields.snmpAgent) data.push({ name: 'agent', value: String(fields.snmpAgent).trim() })
      if (fields.snmpCommunity) data.push({ name: 'community', value: String(fields.snmpCommunity).trim() })
      if (fields.snmpMessage) data.push({ name: 'message', value: String(fields.snmpMessage).trim() })
      break
    case 'Syslog':
    default:
      break
  }
  return { value: method, data }
}

export function buildAlertInput(fields: Record<string, unknown>): AlertInput {
  return {
    name: String(fields.name ?? '').trim(),
    event: eventClause(fields),
    condition: conditionClause(fields),
    method: methodClause(fields),
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live alert by name (trimmed, case-sensitive). */
export function findAlertByName(alerts: GmpAlert[], name: string): GmpAlert | null {
  const n = name.trim()
  if (!n) return null
  return alerts.find((a) => a.name.trim() === n) ?? null
}
