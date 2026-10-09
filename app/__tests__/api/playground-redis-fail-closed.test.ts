// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { NextRequest } from 'next/server';
import * as gate from '../fixtures/gate-playground-access.pr2732';

const state = vi.hoisted(() => ({
  failed: false,
  keys: new Set<string>(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    async set(key: string) {
      if (state.failed) {
        throw new Error('MOCK_REDIS_UNAVAILABLE');
      }

      if (state.keys.has(key)) return null;

      state.keys.add(key);
      return 'OK';
    }
  },
}));

const SECRET = 's'.repeat(40);

async function attempt(sub: string) {
  vi.resetModules();

  const { GET } = await import('@/app/enter/route');

  const token = gate.mintHandoff(sub, 10, SECRET);

  const req = new NextRequest(`https://pg.test/enter?t=${encodeURIComponent(token)}`);

  return GET(req);
}

function accepted(res: Response) {
  return res.status === 303 && (res.headers.get('set-cookie') ?? '').startsWith('pg_access=');
}

describe('AUDIT: Redis fail-closed security policy', () => {
  beforeEach(() => {
    vi.resetModules();

    state.failed = false;
    state.keys.clear();

    vi.stubEnv('PLAYGROUND_ACCESS_SECRET', SECRET);
    vi.stubEnv('PLAYGROUND_GATE_ENABLED', 'true');
    vi.stubEnv('PLAYGROUND_COHORT_CUTOFF', '1000');

    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://mock-redis.example.invalid');

    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('CONTROL-04: gate disabled allows memory fallback on Redis error', async () => {
    vi.stubEnv('PLAYGROUND_GATE_ENABLED', 'false');
    state.failed = true;

    const res = await attempt('gate-off-error');

    expect(accepted(res)).toBe(true);
  });

  it('CONTROL-05: gate disabled allows fallback without Redis config', async () => {
    vi.stubEnv('PLAYGROUND_GATE_ENABLED', 'false');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const res = await attempt('gate-off-no-redis');

    expect(accepted(res)).toBe(true);
  });

  it('CONTROL-06: team bypass survives Redis failure', async () => {
    state.failed = true;

    const teamSecret = 't'.repeat(40);
    vi.stubEnv('PLAYGROUND_TEAM_BYPASS_SECRET', teamSecret);

    vi.resetModules();
    const { GET } = await import('@/app/enter/route');

    const res = await GET(new NextRequest('https://pg.test/enter?team=' + teamSecret));

    expect(accepted(res)).toBe(true);
  });

  it('GATE-ON-TRANSITION-01: healthy to failed rejects replay', async () => {
    const token = gate.mintHandoff('transition-01', 10, SECRET);

    vi.resetModules();
    const { GET } = await import('@/app/enter/route');

    const request = () => new NextRequest('https://pg.test/enter?t=' + encodeURIComponent(token));

    state.failed = false;
    const first = await GET(request());

    state.failed = true;
    const replay = await GET(request());

    console.log('GATE_ON_TRANSITION_01', {
      firstAccepted: accepted(first),
      replayAccepted: accepted(replay),
    });

    expect(accepted(first)).toBe(true);
    expect(accepted(replay)).toBe(false);
    expect(new URL(replay.headers.get('location')!).pathname).toBe('/locked');
  });

  it('GATE-ON-TRANSITION-02: failure to recovery preserves single-use', async () => {
    const token = gate.mintHandoff('transition-02', 10, SECRET);

    vi.resetModules();
    const { GET } = await import('@/app/enter/route');

    const request = () => new NextRequest('https://pg.test/enter?t=' + encodeURIComponent(token));

    state.failed = true;
    const duringFailure = await GET(request());

    state.failed = false;
    const afterRecovery = await GET(request());
    const replay = await GET(request());

    console.log('GATE_ON_TRANSITION_02', {
      duringFailureAccepted: accepted(duringFailure),
      recoveryAccepted: accepted(afterRecovery),
      replayAccepted: accepted(replay),
    });

    expect(accepted(duringFailure)).toBe(false);
    expect(accepted(afterRecovery)).toBe(true);
    expect(accepted(replay)).toBe(false);
  });

  it('GATE-ON-TRANSITION-03: separate instances reject Redis outage', async () => {
    const token = gate.mintHandoff('transition-03', 10, SECRET);

    state.failed = true;

    const request = () => new NextRequest('https://pg.test/enter?t=' + encodeURIComponent(token));

    vi.resetModules();
    const firstRoute = await import('@/app/enter/route');
    const first = await firstRoute.GET(request());

    vi.resetModules();
    const secondRoute = await import('@/app/enter/route');
    const second = await secondRoute.GET(request());

    console.log('GATE_ON_TRANSITION_03', {
      firstAccepted: accepted(first),
      secondAccepted: accepted(second),
    });

    expect(accepted(first)).toBe(false);
    expect(accepted(second)).toBe(false);
  });

  it('CONTROL: healthy Redis permits valid handoff', async () => {
    const res = await attempt('healthy-redis');
    expect(accepted(res)).toBe(true);
  });

  it('RED-01: Redis error must deny handoff', async () => {
    state.failed = true;

    const res = await attempt('redis-error');

    console.log('FAIL_CLOSED_REDIS_ERROR', {
      accepted: accepted(res),
    });

    expect(accepted(res)).toBe(false);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/locked');
  });

  it('RED-02: missing Redis config must deny handoff', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '');

    const res = await attempt('redis-missing');

    console.log('FAIL_CLOSED_REDIS_MISSING', {
      accepted: accepted(res),
    });

    expect(accepted(res)).toBe(false);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/locked');
  });
});
