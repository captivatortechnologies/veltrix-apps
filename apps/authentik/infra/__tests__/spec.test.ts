// Proves the SAME generic SDK renders another, very different tool (authentik).
// Runs in the standard suite via `node scripts/test-apps.mjs authentik`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the authentik spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders authentik-shaped tfvars — HTTP backend on 9000 to the server tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 9000);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/-/health/live/');
  assert.deepEqual(v.load_balancer.target_kinds, ['authentik-server', 'standalone']);
});

test('renders authentik ports as alb/admin/self rules (HTTP 9000, HTTPS 9443, PostgreSQL 5432)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[9000].sources, ['alb']);
  assert.deepEqual(byPort[9443].sources, ['admin']);
  assert.deepEqual(byPort[5432].sources, ['self']);
});

test('authentik has NO Redis rule (removed in authentik 2025.10 — see lib/byolTopology.ts)', () => {
  const v = renderInfraVars(spec);
  const ports = v.security_rules.map((r) => r.port);
  assert.equal(ports.includes(6379), false);
});

test('authentik needs no object storage and enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
