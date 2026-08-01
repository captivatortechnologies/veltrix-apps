// Proves the SAME generic SDK renders another, very different tool (SonarQube). Runs
// in the standard suite via `node scripts/test-apps.mjs sonarqube`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the SonarQube spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders SonarQube-shaped tfvars — HTTP front door on 9000 to the app tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 9000);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/api/system/status');
  assert.deepEqual(v.load_balancer.target_kinds, ['sonarqube-app', 'standalone']);
});

test('renders SonarQube data-service ports as peer/self rules (Elasticsearch 9001, PostgreSQL 5432)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[9001].sources, ['self']);
  assert.deepEqual(byPort[5432].sources, ['self']);
  // The only ALB-facing port is the SonarQube web/API tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [9000]);
});

test('SonarQube enables WAF and infers compute by foundation-exclusion', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
