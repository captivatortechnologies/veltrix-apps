// Proves the SAME generic SDK renders another, very different tool (Keycloak). Runs
// in the standard suite via `node scripts/test-apps.mjs keycloak`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Keycloak spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders Keycloak-shaped tfvars — HTTP front door on 8080 to the Keycloak tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 8080);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/');
  assert.deepEqual(v.load_balancer.target_kinds, ['keycloak', 'standalone']);
});

test('renders Keycloak data-service ports as peer/self rules (PostgreSQL 5432, Infinispan 7800)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[5432].sources, ['self']);
  assert.deepEqual(byPort[7800].sources, ['self']);
  // The only ALB-facing port is the Keycloak web/admin tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [8080]);
});

test('Keycloak needs no object storage and enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
