import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Validate Splunk Enterprise role configurations.
 *
 * Rules mirror the real Splunk contract for /services/authorization/roles
 * and authorize.conf (verified against Splunk Enterprise 9.4/10.x docs):
 *   - Role names cannot have uppercase characters and cannot contain
 *     spaces, colons, semicolons, or forward slashes.
 *   - Built-in roles (admin, power, user, can_delete, splunk-system-role)
 *     are reserved.
 *   - srchJobsQuota (default 3), rtSrchJobsQuota (default 6) and
 *     srchDiskQuota (default 100 MB) are non-negative integers; 0 = no limit.
 *   - srchTimeWin: -1 = unset (default), 0 = exempt from any window,
 *     otherwise a positive number of seconds.
 *   - Capability names are checked against the documented capability list;
 *     unknown names produce warnings (apps can register custom capabilities).
 */

const RESERVED_ROLE_NAMES = ['admin', 'can_delete', 'power', 'splunk-system-role', 'user']
const MAX_ROLE_NAME_LENGTH = 80

/** Characters Splunk forbids in role names (plus uppercase, checked separately). */
const ROLE_NAME_FORBIDDEN = /[\s:;/A-Z]/

/**
 * Documented Splunk Enterprise capabilities (9.4–10.4). Sourced from
 * "Define roles on the Splunk platform with capabilities". Not exhaustive
 * for future versions — unknown names warn instead of erroring.
 */
const KNOWN_CAPABILITIES = new Set([
  'accelerate_datamodel', 'accelerate_search', 'admin_all_objects', 'apps_backup', 'apps_restore',
  'capture_ingest_events', 'change_authentication', 'change_own_password', 'create_bulk_data_move',
  'create_external_lookup', 'delete_by_keyword', 'delete_messages', 'dispatch_rest_to_indexers',
  'edit_authentication_extensions', 'edit_bookmarks_mc', 'edit_cmd', 'edit_deployment_client',
  'edit_deployment_server', 'edit_dist_peer', 'edit_encryption_key_provider', 'edit_external_lookup',
  'edit_field_filter', 'edit_forwarders', 'edit_global_banner', 'edit_health', 'edit_health_subset',
  'edit_httpauths', 'edit_indexer_cluster', 'edit_indexerdiscovery', 'edit_ingest_rulesets',
  'edit_input_defaults', 'edit_kvstore', 'edit_local_apps', 'edit_log_alert_event', 'edit_manager_xml',
  'edit_metric_schema', 'edit_metrics_rollup', 'edit_modinput_journald', 'edit_monitor',
  'edit_own_objects', 'edit_published_dashboards', 'edit_roles', 'edit_roles_grantable',
  'edit_scripted', 'edit_search_concurrency_all', 'edit_search_concurrency_scheduled',
  'edit_search_head_clustering', 'edit_search_schedule_priority', 'edit_search_schedule_window',
  'edit_search_scheduler', 'edit_search_server', 'edit_server', 'edit_server_crl', 'edit_sourcetypes',
  'edit_spl2_module_permissions', 'edit_spl2_modules', 'edit_splunktcp', 'edit_splunktcp_ssl',
  'edit_splunktcp_token', 'edit_statsd_transforms', 'edit_storage_passwords', 'edit_tcp',
  'edit_tcp_stream', 'edit_telemetry_settings', 'edit_token_http', 'edit_tokens_all',
  'edit_tokens_own', 'edit_tokens_settings', 'edit_udp', 'edit_upload_and_index', 'edit_user',
  'edit_view_html', 'edit_watchdog', 'edit_web_features', 'edit_web_settings', 'edit_workload_policy',
  'edit_workload_pools', 'edit_workload_rules', 'embed_report', 'export_results_is_visible',
  'fsh_manage', 'fsh_search', 'get_diag', 'get_metadata', 'get_typeahead', 'indexes_edit',
  'input_file', 'install_apps', 'license_edit', 'license_read', 'license_tab',
  'license_view_warnings', 'list_all_objects', 'list_all_roles', 'list_all_users',
  'list_accelerate_search', 'list_cascading_plans', 'list_deployment_client',
  'list_deployment_server', 'list_dist_peer', 'list_field_filter', 'list_forwarders', 'list_health',
  'list_health_subset', 'list_httpauths', 'list_indexer_cluster', 'list_indexerdiscovery',
  'list_ingest_rulesets', 'list_inputs', 'list_introspection', 'list_metrics_catalog',
  'list_pipeline_sets', 'list_remote_input_queue', 'list_remote_output_queue',
  'list_search_head_clustering', 'list_search_scheduler', 'list_settings', 'list_spl2_datasets',
  'list_spl2_modules', 'list_storage_passwords', 'list_token_http', 'list_tokens_all',
  'list_tokens_own', 'list_tokens_scs', 'list_workload_policy', 'list_workload_pools',
  'list_workload_rules', 'merge_buckets', 'metric_alerts', 'never_expire', 'never_lockout',
  'output_file', 'pattern_detect', 'read_internal_libraries_settings',
  'refresh_application_licenses', 'request_remote_tok', 'rest_access_server_endpoints',
  'rest_apps_management', 'rest_apps_view', 'rest_properties_get', 'rest_properties_set',
  'restart_reason', 'restart_splunkd', 'rtsearch', 'run_collect',
  'run_commands_ignoring_field_filter', 'run_custom_command', 'run_debug_commands', 'run_dump',
  'run_mcollect', 'run_msearch', 'run_sendalert', 'run_walklex', 'schedule_rtsearch',
  'schedule_search', 'search', 'search_process_config_refresh', 'select_workload_pools',
  'splunk_assist_admin', 'splunk_mobile_administration', 'upgrade_splunk_idxc', 'upgrade_splunk_shc',
  'upload_lookup_files', 'upload_mmdb_files', 'use_file_operator', 'use_remote_proxy', 'web_debug',
])

/** Capabilities that grant sweeping administrative power — flag for review. */
const PRIVILEGED_CAPABILITIES = new Set([
  'admin_all_objects', 'change_authentication', 'edit_roles', 'edit_user', 'restart_splunkd',
])

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no role definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const roleNames = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // --- Role name ----------------------------------------------------------
    const name = fields.name as string | undefined
    if (!name || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else {
      if (ROLE_NAME_FORBIDDEN.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Role names cannot have uppercase characters or contain spaces, colons, semicolons, or forward slashes',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_ROLE_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`, code: 'max_length' })
      }
      if (RESERVED_ROLE_NAMES.includes(name)) {
        errors.push({ field: `${prefix}.name`, message: `"${name}" is a reserved Splunk role`, code: 'reserved_name' })
      }
      if (roleNames.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate role name: "${name}"`, code: 'duplicate' })
      }
      roleNames.add(name)
    }

    // --- Capabilities ---------------------------------------------------------
    const capabilities = fields.capabilities as string[] | undefined
    if (capabilities !== undefined && !Array.isArray(capabilities)) {
      errors.push({ field: `${prefix}.capabilities`, message: 'Capabilities must be an array', code: 'invalid_type' })
    } else if (Array.isArray(capabilities)) {
      for (const cap of capabilities) {
        if (typeof cap !== 'string' || cap.trim().length === 0) {
          errors.push({ field: `${prefix}.capabilities`, message: 'Capabilities must be non-empty strings', code: 'invalid_value' })
          continue
        }
        if (!KNOWN_CAPABILITIES.has(cap)) {
          warnings.push({
            field: `${prefix}.capabilities`,
            message: `"${cap}" is not a documented Splunk capability — verify the name (custom app capabilities are allowed)`,
            code: 'unknown_capability',
          })
        }
        if (PRIVILEGED_CAPABILITIES.has(cap)) {
          warnings.push({
            field: `${prefix}.capabilities`,
            message: `"${cap}" grants broad administrative access — review against least-privilege policy`,
            code: 'privileged_capability',
          })
        }
      }
    }

    // --- Search filter ---------------------------------------------------------
    const srchFilter = fields.srchFilter as string | undefined
    if (srchFilter && typeof srchFilter === 'string' && srchFilter.length > 2000) {
      warnings.push({ field: `${prefix}.srchFilter`, message: 'Search filter is very long — may impact performance', code: 'long_filter' })
    }

    // --- Imported roles ----------------------------------------------------------
    const importedRoles = fields.importedRoles as string[] | undefined
    if (importedRoles && Array.isArray(importedRoles)) {
      if (name && importedRoles.includes(name)) {
        errors.push({ field: `${prefix}.importedRoles`, message: 'Role cannot import itself', code: 'circular_import' })
      }
      if (importedRoles.includes('admin')) {
        warnings.push({
          field: `${prefix}.importedRoles`,
          message: 'Importing the admin role grants full administrative access — review against least-privilege policy',
          code: 'privileged_import',
        })
      }
    }

    // --- Index access ---------------------------------------------------------------
    const indexesAllowed = fields.srchIndexesAllowed as string[] | undefined
    if (indexesAllowed !== undefined && !Array.isArray(indexesAllowed)) {
      errors.push({ field: `${prefix}.srchIndexesAllowed`, message: 'Allowed indexes must be an array', code: 'invalid_type' })
    } else if (Array.isArray(indexesAllowed) && indexesAllowed.some((i) => i === '*' || i === '_*')) {
      warnings.push({
        field: `${prefix}.srchIndexesAllowed`,
        message: 'Wildcard index access grants searches over all (or all internal) indexes — scope to specific indexes where possible',
        code: 'broad_index_access',
      })
    }
    const indexesDefault = fields.srchIndexesDefault as string[] | undefined
    if (indexesDefault !== undefined && !Array.isArray(indexesDefault)) {
      errors.push({ field: `${prefix}.srchIndexesDefault`, message: 'Default indexes must be an array', code: 'invalid_type' })
    }

    // --- Quotas -------------------------------------------------------------------
    const diskQuota = fields.srchDiskQuota as number | undefined
    if (diskQuota !== undefined && (typeof diskQuota !== 'number' || diskQuota < 0)) {
      errors.push({ field: `${prefix}.srchDiskQuota`, message: 'Search disk quota must be a non-negative number', code: 'invalid_value' })
    }

    const jobsQuota = fields.srchJobsQuota as number | undefined
    if (jobsQuota !== undefined) {
      if (typeof jobsQuota !== 'number' || jobsQuota < 0) {
        errors.push({ field: `${prefix}.srchJobsQuota`, message: 'Search jobs quota must be a non-negative number', code: 'invalid_value' })
      } else if (jobsQuota > 100) {
        warnings.push({ field: `${prefix}.srchJobsQuota`, message: 'High search jobs quota may impact cluster performance', code: 'high_quota' })
      }
    }

    const rtJobsQuota = fields.rtSrchJobsQuota as number | undefined
    if (rtJobsQuota !== undefined) {
      if (typeof rtJobsQuota !== 'number' || rtJobsQuota < 0) {
        errors.push({ field: `${prefix}.rtSrchJobsQuota`, message: 'Real-time search jobs quota must be a non-negative number', code: 'invalid_value' })
      } else if (rtJobsQuota > 100) {
        warnings.push({ field: `${prefix}.rtSrchJobsQuota`, message: 'High real-time search quota may impact cluster performance', code: 'high_quota' })
      }
    }

    // --- Search time window -------------------------------------------------------
    // -1 = unset (default), 0 = exempt from any window, >0 = window in seconds
    const timeWin = fields.srchTimeWin as number | undefined
    if (timeWin !== undefined) {
      if (typeof timeWin !== 'number' || !Number.isInteger(timeWin) || timeWin < -1) {
        errors.push({
          field: `${prefix}.srchTimeWin`,
          message: 'Search time window must be -1 (unset), 0 (exempt), or a positive number of seconds',
          code: 'invalid_value',
        })
      } else if (timeWin === 0) {
        warnings.push({
          field: `${prefix}.srchTimeWin`,
          message: 'srchTimeWin=0 exempts this role from any search time window, including inherited limits',
          code: 'unbounded_search_window',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
