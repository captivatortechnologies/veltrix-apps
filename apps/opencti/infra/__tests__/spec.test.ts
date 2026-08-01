// Proves the SAME generic SDK renders another, very different tool (OpenCTI). Runs
// in the standard suite via `node scripts/test-apps.mjs opencti`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the OpenCTI spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders OpenCTI-shaped tfvars — HTTP front door on 4000 to the platform tier', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 4000);
  assert.equal(v.load_balancer.target_protocol, 'HTTP');
  assert.equal(v.load_balancer.health_check_path, '/');
  assert.deepEqual(v.load_balancer.target_kinds, ['opencti-platform', 'standalone']);
});

test('renders OpenCTI data-service ports as peer/self rules (Redis 6379, RabbitMQ 5672, MinIO 9000)', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[6379].sources, ['self']);
  assert.deepEqual(byPort[5672].sources, ['self']);
  assert.deepEqual(byPort[9000].sources, ['self']);
  // The only ALB-facing port is the OpenCTI web/GraphQL tier.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port);
  assert.deepEqual(albPorts, [4000]);
});

test('OpenCTI declares an object-storage bucket and enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // Compute is inferred by foundation-exclusion (no explicit allow-list).
  assert.deepEqual(v.compute_kinds, []);
});
