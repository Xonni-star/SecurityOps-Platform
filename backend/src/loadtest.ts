import crypto from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {errorRate, summarizeLatencies} from './loadtest-metrics.js';

type Status = 'PASS' | 'OPEN';
type InfraStatus = {status: 'PASS' | 'OPEN' | 'NOT_IN_SCOPE'; detail: string};
type RequestResult = {ok: boolean; status?: number; latencyMs: number; error?: string};

const baseUrl = (process.env.LOADTEST_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const email = process.env.LOADTEST_EMAIL;
const password = process.env.LOADTEST_PASSWORD;
const deviceId = process.env.LOADTEST_DEVICE_ID;
const priorityId = process.env.LOADTEST_PRIORITY_ID;
const clients = numberEnv('LOADTEST_CLIENTS', 10, 1, 1000);
const rps = numberEnv('LOADTEST_RPS', 10, 1, 1000);
const durationSeconds = numberEnv('LOADTEST_DURATION_SECONDS', 10, 1, 3600);
const fanoutEvents = numberEnv('LOADTEST_FANOUT_EVENTS', Math.max(1, Math.ceil(rps)), 1, 10000);
const exports = numberEnv('LOADTEST_EXPORTS', 3, 1, 100);
const timeoutMs = numberEnv('LOADTEST_REQUEST_TIMEOUT_MS', 10000, 100, 120000);
const corsOrigin = process.env.LOADTEST_ORIGIN ?? 'http://localhost:5173';
const outputPath = process.env.LOADTEST_OUTPUT ?? `loadtest-results/${new Date().toISOString().replaceAll(':', '-')}.json`;
const runId = `loadtest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function requiredInfra(): Set<string> {
  return new Set((process.env.LOADTEST_REQUIRED_INFRA ?? 'postgres').split(',').map(value => value.trim()).filter(Boolean));
}

async function checkUrl(url: string): Promise<InfraStatus> {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    return response.ok ? {status: 'PASS', detail: `${response.status} ${url}`} : {status: 'OPEN', detail: `${response.status} ${url}`};
  } catch (error) {
    return {status: 'OPEN', detail: `${url}: ${error instanceof Error ? error.message : String(error)}`};
  }
}

async function checkInfrastructure(): Promise<Record<string, InfraStatus>> {
  const required = requiredInfra();
  const result: Record<string, InfraStatus> = {
    postgres: await checkUrl(`${baseUrl}/ready`),
    docker: {status: 'NOT_IN_SCOPE', detail: 'The harness uses an already started service; CI provisions Docker separately.'},
    redis: {status: 'NOT_IN_SCOPE', detail: 'The current alarm, WS and report paths do not use Redis.'},
    provider: {status: 'NOT_IN_SCOPE', detail: 'The current report export is local API output; no external provider is called.'},
  };
  if (required.has('docker')) {
    result.docker = {status: 'OPEN', detail: 'Docker prerequisite must be checked by the CI runner before invoking the harness.'};
  }
  if (required.has('redis')) {
    result.redis = process.env.LOADTEST_REDIS_URL ? await checkUrl(process.env.LOADTEST_REDIS_URL) : {status: 'OPEN', detail: 'LOADTEST_REDIS_URL is required'};
  }
  if (required.has('provider')) {
    result.provider = process.env.LOADTEST_PROVIDER_HEALTH_URL
      ? await checkUrl(process.env.LOADTEST_PROVIDER_HEALTH_URL)
      : {status: 'OPEN', detail: 'LOADTEST_PROVIDER_HEALTH_URL is required'};
  }
  return result;
}

type Session = {cookie: string; csrf: string};

function cookieValue(cookie: string, name: string): string | undefined {
  return cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function login(): Promise<Session> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin: corsOrigin},
    body: JSON.stringify({email, password, device_id: deviceId, metadata: {platform: 'isolated-loadtest', app_version: 'phase-4-13d'}}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`login failed with HTTP ${response.status}`);
  const cookies = response.headers.getSetCookie?.() ?? (response.headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/);
  const sessionCookie = cookies.find(cookie => cookie.startsWith('securityops_session='));
  const csrfCookie = cookies.find(cookie => cookie.startsWith('securityops_csrf='));
  const csrf = csrfCookie ? cookieValue(csrfCookie, 'securityops_csrf') : undefined;
  if (!sessionCookie || !csrf) throw new Error('login did not return session and CSRF cookies');
  return {cookie: sessionCookie.split(';')[0], csrf};
}

async function apiRequest(session: Session, path: string, init: RequestInit = {}): Promise<RequestResult & {body?: Uint8Array}> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {'content-type': 'application/json', origin: corsOrigin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...(init.headers ?? {})},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {ok: response.ok, status: response.status, latencyMs: performance.now() - started, body, error: response.ok ? undefined : `HTTP ${response.status}`};
  } catch (error) {
    return {ok: false, latencyMs: performance.now() - started, error: error instanceof Error ? error.message : String(error)};
  }
}

async function pacedRequests(count: number, rate: number, action: () => Promise<RequestResult>): Promise<RequestResult[]> {
  const results: Promise<RequestResult>[] = [];
  const intervalMs = 1000 / rate;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const due = started + index * intervalMs;
    const wait = due - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    results.push(action());
  }
  return Promise.all(results);
}

function requestMetrics(results: RequestResult[], elapsedMs: number) {
  const errors = results.filter(result => !result.ok).length;
  return {
    attempted: results.length,
    succeeded: results.length - errors,
    errors,
    errorRate: errorRate(errors, results.length),
    latency: summarizeLatencies(results.map(result => result.latencyMs)),
    throughputRps: results.length / Math.max(elapsedMs / 1000, 0.001),
  };
}

async function runAlarmIngest(session: Session) {
  const count = Math.max(1, Math.ceil(rps * durationSeconds));
  const started = performance.now();
  const results = await pacedRequests(count, rps, () => apiRequest(session, '/api/v1/alarms', {
    method: 'POST',
    body: JSON.stringify({
      type: 'load_test',
      priority_id: priorityId,
      source: runId,
      description: `Isolated Phase 4 load-test alarm ${runId}`,
      client_event_id: crypto.randomUUID(),
    }),
  }));
  return {config: {rps, durationSeconds, payloadBytes: Buffer.byteLength(`Isolated Phase 4 load-test alarm ${runId}`)}, metrics: requestMetrics(results, performance.now() - started)};
}

async function openFanoutClient(session: Session): Promise<{socket: WebSocket; deliveries: number; latencies: number[]}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws`, {headers: {cookie: session.cookie, origin: corsOrigin}});
    const client = {socket, deliveries: 0, latencies: [] as number[]};
    const timer = setTimeout(() => reject(new Error('WS client did not connect in time')), timeoutMs);
    socket.on('open', () => { clearTimeout(timer); resolve(client); });
    socket.on('message', data => {
      try {
        const message = JSON.parse(data.toString()) as {type?: string; payload?: {source?: string}; timestamp?: string};
        if (message.type === 'alarm.created' && message.payload?.source === runId) {
          client.deliveries += 1;
          if (message.timestamp) client.latencies.push(Math.max(0, Date.now() - Date.parse(message.timestamp)));
        }
      } catch {
        // Ignore malformed non-contract frames; the phase remains accountable through delivery counts.
      }
    });
    socket.on('error', error => reject(error));
  });
}

async function runFanout(session: Session) {
  const fanoutSessions = await Promise.all(Array.from({length: clients}, () => login()));
  const sockets = await Promise.all(fanoutSessions.map(openFanoutClient));
  const started = performance.now();
  const results = await pacedRequests(fanoutEvents, rps, () => apiRequest(session, '/api/v1/alarms', {
    method: 'POST',
    body: JSON.stringify({
      type: 'load_test_fanout',
      priority_id: priorityId,
      source: runId,
      description: `Isolated Phase 4 WS fanout event ${runId}`,
      client_event_id: crypto.randomUUID(),
    }),
  }));
  await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 2000)));
  for (const client of sockets) client.socket.close();
  const delivered = sockets.reduce((sum, client) => sum + client.deliveries, 0);
  const expected = fanoutEvents * clients;
  const latencies = sockets.flatMap(client => client.latencies);
  const ingestMetrics = requestMetrics(results, performance.now() - started);
  return {
    config: {clients, events: fanoutEvents, targetRps: rps},
    metrics: {...ingestMetrics, delivered, expected, fanoutDeliveryRate: delivered / expected, fanoutLatency: summarizeLatencies(latencies)},
  };
}

async function runExports(session: Session) {
  const results = [];
  for (let index = 0; index < exports; index += 1) {
    results.push(await apiRequest(session, `/api/v1/reports/alarms?format=${process.env.LOADTEST_EXPORT_FORMAT === 'pdf' ? 'pdf' : 'csv'}`, {method: 'GET'}));
  }
  const bytes = results.reduce((sum, result) => sum + (result.body?.byteLength ?? 0), 0);
  return {config: {exports, format: process.env.LOADTEST_EXPORT_FORMAT === 'pdf' ? 'pdf' : 'csv'}, metrics: {...requestMetrics(results, results.reduce((sum, result) => sum + result.latencyMs, 0)), bytes}};
}

const thresholds = {
  maxErrorRate: Number(process.env.LOADTEST_MAX_ERROR_RATE ?? 0),
  minThroughputRps: Number(process.env.LOADTEST_MIN_THROUGHPUT_RPS ?? 0),
  minFanoutDeliveryRate: Number(process.env.LOADTEST_MIN_FANOUT_DELIVERY_RATE ?? 1),
  maxP95Ms: Number(process.env.LOADTEST_MAX_P95_MS ?? 0),
};

async function main() {
  const infrastructure = await checkInfrastructure();
  const required = requiredInfra();
  const infraOpen = [...required].some(name => infrastructure[name]?.status !== 'PASS');
  const result: Record<string, unknown> = {
    status: 'OPEN' as Status,
    runId,
    startedAt: new Date().toISOString(),
    environment: {baseUrl, node: process.version, platform: process.platform, arch: process.arch},
    load: {clients, rps, durationSeconds, fanoutEvents, exports, timeoutMs},
    infrastructure,
    thresholds,
  };
  if (infraOpen) {
    result.reason = 'Required infrastructure is unavailable; no load phase was executed.';
  } else if (!email || !password || !deviceId || !priorityId) {
    result.reason = 'LOADTEST_EMAIL, LOADTEST_PASSWORD, LOADTEST_DEVICE_ID and LOADTEST_PRIORITY_ID are required.';
  } else {
    try {
      const session = await login();
      const alarmIngest = await runAlarmIngest(session);
      const fanout = await runFanout(session);
      const reportExport = await runExports(session);
      result.phases = {alarmIngest, websocketFanout: fanout, reportExport};
      const phaseMetrics = [alarmIngest.metrics, fanout.metrics, reportExport.metrics];
      const p95 = Math.max(...phaseMetrics.map(metrics => metrics.latency.p95Ms ?? Number.POSITIVE_INFINITY));
      const passed = phaseMetrics.every(metrics => metrics.errorRate <= thresholds.maxErrorRate && metrics.throughputRps >= thresholds.minThroughputRps)
        && fanout.metrics.fanoutDeliveryRate >= thresholds.minFanoutDeliveryRate
        && (!thresholds.maxP95Ms || p95 <= thresholds.maxP95Ms);
      result.status = passed ? 'PASS' : 'OPEN';
      if (!passed) result.reason = 'Measured results did not meet configured baseline criteria.';
    } catch (error) {
      result.reason = `Load test setup or execution failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  await mkdir(outputPath.split('/').slice(0, -1).join('/') || '.', {recursive: true});
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 2;
}

await main();
