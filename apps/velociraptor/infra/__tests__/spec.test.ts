// Proves the SAME generic SDK renders another, very different tool (Velociraptor).
// Runs in the standard suite via `node scripts/test-apps.mjs velociraptor`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInfraSpec, renderInfraVars } from '@veltrixsecops/app-sdk/opentofu';
import { spec } from '../spec.js';

test('the Velociraptor spec is valid', () => {
  assert.deepEqual(validateInfraSpec(spec), []);
});

test('renders Velociraptor-shaped tfvars — HTTPS GUI front door on 8889 to the frontend', () => {
  const v = renderInfraVars(spec);
  assert.ok(v.load_balancer, 'expected a load balancer');
  assert.equal(v.load_balancer.target_port, 8889);
  assert.equal(v.load_balancer.target_protocol, 'HTTPS');
  assert.equal(v.load_balancer.health_check_path, '/app/index.html');
  assert.deepEqual(v.load_balancer.target_kinds, ['velociraptor-server', 'standalone']);
});

test('renders Velociraptor ports — GUI/frontend via ALB, API admin-only, MinIO peer-only', () => {
  const v = renderInfraVars(spec);
  const byPort = Object.fromEntries(v.security_rules.map((r) => [r.port, r]));
  assert.deepEqual(byPort[9000].sources, ['self']);
  assert.deepEqual(byPort[8001].sources, ['admin']);
  // The ALB-facing ports are the GUI + frontend web tiers.
  const albPorts = v.security_rules.filter((r) => r.sources.includes('alb')).map((r) => r.port).sort((a, b) => a - b);
  assert.deepEqual(albPorts, [8000, 8889]);
});

test('Velociraptor needs no foundation object storage (datastore is a MinIO node) yet enables WAF', () => {
  const v = renderInfraVars(spec);
  assert.equal(v.waf_enabled, true);
  assert.equal(v.alb_auth.enabled, false);
  // No explicit compute allow-list — Velociraptor roles are compute via foundation-exclusion.
  assert.deepEqual(v.compute_kinds, []);
});
