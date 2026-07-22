# Changelog

All notable changes to the Elastic Security app are documented here. This
project adheres to [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-07-22

### Added
- **Drift attribution — "who changed it + when".** When drift is detected on a
  managed Elastic object, each reported difference is now annotated with the
  person who made the last change and when. The platform stores the `actor` on
  each diff and the drift view renders it, so a drift alert answers *who* and
  *when*, not just *what*.
  - Attribution reads the modifier Kibana records DIRECTLY on the drifted object
    — `updated_by` / `updated_at` (the last writer, preferred), with
    `created_by` / `created_at` as a fallback — which the drift check already
    fetches. This is the most reliable actor source (the object's own record of
    its last writer) and needs no extra API call, scope or audit-log query.
  - Applies to the config types whose objects carry a modifier: **detection
    rules** (per rule) and **exception lists** (the list container and each item
    are attributed independently to their own last writer).
  - An email-shaped principal (SSO) is surfaced as the actor's email; a bare
    username is surfaced as the actor id. The raw value is always kept as the
    display name.
  - Veltrix's own deploys are recorded under the connection's login, so a change
    WE made is excluded via that login — the attribution reflects the *manual*
    change rather than our deploy.
  - **Strictly best-effort:** attribution never throws and never fails a drift
    check — on any error, or when an object carries no usable modifier (a deleted
    object, or an object with none recorded), the diff is reported without an
    actor and the drift view shows "—". Only objects that actually drifted are
    attributed (one resolution per drifted object).
  - **Unattributed by design:** Elasticsearch ILM policies, Elasticsearch role
    mappings and Kibana spaces expose no per-object modifier (and no per-object
    audit trail through this app's API), so their drift is reported without an
    actor. The attribution is still wired uniformly, so it will surface a modifier
    automatically if Elastic ever records one — it is never fabricated.
