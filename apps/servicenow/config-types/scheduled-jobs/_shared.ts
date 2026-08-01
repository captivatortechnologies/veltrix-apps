// Shared spec for the ServiceNow Scheduled Jobs config type (sysauto_script).
//
// A Scheduled Script Execution runs a server-side script on a time-based
// schedule (optionally under a specific user and gated by a condition) — a
// security-relevant surface because it executes privileged code unattended.
// This app manages the record as code over the Table API.
//
// sysauto_script columns managed below:
//   name           Name (identity)
//   active         Enabled flag
//   run_type       Schedule frequency (daily | weekly | monthly | periodically | once | on_demand)
//   run_time       Time of day to run (HH:MM:SS)
//   run_start      First eligible run (date/time) — used by once / periodically
//   run_dayofweek  Day of week (1-7) — used by weekly
//   run_period     Interval as a GlideDuration date-time — used by periodically
//   run_as         User (sys_id) the script runs as
//   conditional    Whether the condition script gates each run
//   condition      Server-side condition script (must evaluate truthy to run)
//   script         Server-side script body
//
// Identity is `name` — the natural key an operator controls. The run_* columns
// follow the sysauto/sysauto_script convention; see README (verify exact names
// and accepted run_type values against your instance's dictionary).

import type { TableConfigSpec } from '../../lib/tableConfig'
import { normalizeBool, trimStr } from '../../lib/tableRecords'

export const SYSAUTO_SCRIPT_TABLE = 'sysauto_script'

/** Commonly-documented run_type values. See README — ServiceNow supports more; verify per instance. */
export const RUN_TYPE_VALUES = new Set(['daily', 'weekly', 'monthly', 'periodically', 'once', 'on_demand'])

export const MANAGED_COLUMNS = [
  'name',
  'active',
  'run_type',
  'run_time',
  'run_start',
  'run_dayofweek',
  'run_period',
  'run_as',
  'conditional',
  'condition',
  'script',
] as const

export const spec: TableConfigSpec = {
  table: SYSAUTO_SCRIPT_TABLE,
  managedColumns: MANAGED_COLUMNS,
  identityColumns: ['name'],
  boolColumns: ['active', 'conditional'],
  criticalColumns: ['script', 'active', 'run_as'],
  identityOf: (f) => ({ name: trimStr(f.name) }),
  labelOf: (f) => trimStr(f.name) || '(unnamed)',
  buildBody: (f) => ({
    name: trimStr(f.name),
    active: normalizeBool(f.active),
    run_type: trimStr(f.runType),
    run_time: trimStr(f.runTime),
    run_start: trimStr(f.runStart),
    run_dayofweek: trimStr(f.runDayofweek),
    run_period: trimStr(f.runPeriod),
    run_as: trimStr(f.runAs),
    conditional: normalizeBool(f.conditional),
    condition: String(f.condition ?? ''),
    script: String(f.script ?? ''),
  }),
}
