# Changelog

## 0.9.0 — 2026-09-16

A minor rather than a patch: `veltrix validate` is stricter, so a migration that
passed locally before may now fail. That is the point — every one of these rules
was already enforced by the platform at install time, and this closes the gap
where the two disagreed.

All 96 apps in this repository still validate clean, so no published app is
affected.

### Migration rules now checked locally

- **Session and transaction state statements are rejected.** `SET`, `RESET`,
  `DO`, `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION`, `SAVEPOINT`,
  `LISTEN`, `NOTIFY`, `LOAD` and `DISCARD` as the leading token of a statement.
  Migrations run inside a transaction the platform controls, and an app has no
  legitimate need for any of them. `UPDATE t SET c = v` and
  `ALTER TABLE t ... SET ...` are unaffected, because `SET` does not lead there.
- **`set_config()` is rejected** as the function form of `SET`, along with
  `SECURITY DEFINER` and `CREATE PROCEDURE`.
- **A schema-isolated app's tables must declare a `customer_id` column.** An
  app's schema is per-app, not per-tenant, so without it every tenant that
  enables the app shares one undivided pool of rows.
- **`CREATE TABLE ... AS SELECT` is rejected outright.** It declares no column
  list, so the table cannot carry the tenant column.

### Statement splitting

The naive `split(';')` is replaced with the platform's tokenizer, which drops
comments and preserves string and dollar-quoted bodies verbatim. The old split
was wrong in both directions:

- A semicolon inside a comment split the statement mid-comment, so trailing
  prose was reported as a broken statement.
- Leading comments stayed attached, which defeated the start-anchored check
  above. A migration beginning with a comment and then `SET LOCAL ROLE NONE`
  validated clean here and was refused by the platform — the exact statement the
  rule exists to catch, reported as fine by the tool meant to catch it.

A validator that disagrees with the platform is worse than none, because it is
believed.
