import { NextResponse } from 'next/server';

import { getEnv } from '@/env';
import { APP_VERSION } from '@/lib/version';
import { getProviders } from '@/providers';

// Liveness must reflect this process, not a build-time snapshot.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const env = getEnv();
  const providers = getProviders();
  const data = await providers.data.health();

  return NextResponse.json({
    status: data.ok ? 'ok' : 'degraded',
    service: 'civora-web',
    version: APP_VERSION,
    checkedAt: new Date().toISOString(),
    runtime: { node: process.version },
    application: { name: env.appName },
    adapters: {
      data: { kind: data.kind, ok: data.ok, detail: data.detail },
      auth: { kind: providers.auth.kind },
      reasoning: { kind: providers.reasoning.kind },
    },
    // This build serves simulated data from local adapters. Nothing it reports
    // is a real stock position and nothing here is a real deployment.
    simulated: true,
  });
}
