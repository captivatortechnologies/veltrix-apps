# Changelog

## 1.0.0

First npm release.

### Added

- Schema discovery: `veltrix_get_app`, `veltrix_get_config_type_schema`, `veltrix_get_environment_policy`.
- Approver lookup: `veltrix_list_approvers`.
- Review loop: `veltrix_list_canvas_comments`, `veltrix_add_canvas_comment`.
- Versions: `veltrix_get_canvas_history`, `veltrix_get_canvas_version`, `veltrix_compare_canvas_versions`, `veltrix_restore_canvas_version`, `veltrix_duplicate_canvas`, `veltrix_export_canvas`.
- Pipeline: `veltrix_get_pipeline_status`, `veltrix_pause_deployment`, `veltrix_resume_deployment`, `veltrix_promote_deployment`.
- Drift: `veltrix_detect_drift`, `veltrix_resolve_drift`.
- Reports: `veltrix_audit_logs`.
- Prompts: `veltrix_propose_change`, `veltrix_triage_drift`, `veltrix_deployment_report`.
- Complete tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool.
- Response-size cap (`VELTRIX_MCP_MAX_RESULT_CHARS`, default 60000) with a truncation notice.
- HTTP mode: `Host` header allowlist (`VELTRIX_MCP_ALLOWED_HOSTS`; localhost-only by default when a fallback key is configured), rejection of credentials that are not `vltx_` keys before any upstream call, graceful shutdown on `SIGTERM` / `SIGINT`.
- `--help` and `--version`.

### Changed

- Requires a Veltrix platform that enforces propose-only for API keys and lets role-bound keys list users and read configuration-type templates. On older platforms `veltrix_list_approvers` and `veltrix_get_config_type_schema` return 401.
- `@modelcontextprotocol/sdk` 1.32, `zod` 4, `express` 5.
- stdio mode refuses to start when `VELTRIX_API_KEY` is not a `vltx_` key.

## 0.1.0

Initial server: 26 tools over stdio and stateless Streamable HTTP, tier-entitlement gate, request timeouts. Not published to npm.
