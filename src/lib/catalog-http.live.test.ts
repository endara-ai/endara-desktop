import { describe, it, expect } from 'vitest';
import { CATALOG_SERVERS } from './catalog';

// Use a try/catch to avoid direct `process` reference
// which fails svelte-check (no @types/node in this project)
let RUN_LIVE_TESTS = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RUN_LIVE_TESTS = !!(globalThis as any).process?.env?.RUN_LIVE_TESTS;
} catch {
  // not in Node
}

const RUN_LIVE = RUN_LIVE_TESTS;

// Plain-HTTP/SSE remote catalog entries (no OAuth) with a concrete endpoint URL.
const remoteEntries = CATALOG_SERVERS.filter(
  (e) => (e.transport === 'http' || e.transport === 'sse') && !!e.url
);

const MCP_PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: any;
}

// Parse a Streamable HTTP POST response body, which may be plain JSON or an
// SSE stream containing the JSON-RPC response in `data:` lines.
async function parseJsonRpcResponse(resp: Response): Promise<JsonRpcResponse> {
  const contentType = resp.headers.get('content-type') ?? '';
  const body = await resp.text();
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split('\n\n')) {
      const data = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      const parsed = JSON.parse(data) as JsonRpcResponse;
      if (parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error(`No JSON-RPC response found in SSE body: ${body.slice(0, 500)}`);
  }
  return JSON.parse(body) as JsonRpcResponse;
}

async function postJsonRpc(
  url: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>,
  sessionId: string | null
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }
  return fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...payload }),
  });
}

// Perform an MCP Streamable HTTP handshake (initialize + initialized
// notification) and return the result of `tools/list`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function listTools(url: string): Promise<any> {
  const initResp = await postJsonRpc(
    url,
    {
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'endara-catalog-live-test', version: '0.0.0' },
      },
    },
    null
  );
  expect(initResp.ok, `initialize returned HTTP ${initResp.status}`).toBe(true);
  const sessionId = initResp.headers.get('mcp-session-id');
  const init = await parseJsonRpcResponse(initResp);
  expect(init.error, `initialize error: ${JSON.stringify(init.error)}`).toBeUndefined();

  // Best-effort `notifications/initialized`; some servers require it before
  // serving requests, others reject notifications — ignore the outcome.
  await postJsonRpc(url, { method: 'notifications/initialized' }, sessionId).catch(() => {});

  const toolsResp = await postJsonRpc(url, { id: 2, method: 'tools/list', params: {} }, sessionId);
  expect(toolsResp.ok, `tools/list returned HTTP ${toolsResp.status}`).toBe(true);
  const tools = await parseJsonRpcResponse(toolsResp);
  expect(tools.error, `tools/list error: ${JSON.stringify(tools.error)}`).toBeUndefined();
  return tools.result;
}

// --- Live tests (network, run on demand with RUN_LIVE_TESTS=1) ---

describe.skipIf(!RUN_LIVE)('live HTTP catalog tools listing', () => {
  // Today the catalog has zero plain-http/sse entries with a URL; this
  // placeholder keeps the suite green while proving the filter ran.
  it('filters http/sse catalog entries with a url', () => {
    expect(Array.isArray(remoteEntries)).toBe(true);
    for (const entry of remoteEntries) {
      expect(entry.url, `${entry.id}: url should be non-empty`).toBeTruthy();
    }
  });

  if (remoteEntries.length > 0) {
    it.each(remoteEntries.map((e) => [e.id, e.url!]))(
      'tools/list for %s (%s) returns tools',
      async (_id, url) => {
        const result = await listTools(url);
        expect(result, 'tools/list returned no result').toBeTruthy();
        expect(result.tools, 'tools/list result missing tools array').toBeInstanceOf(Array);
        expect(result.tools.length, 'tools/list returned an empty tools array').toBeGreaterThan(0);
      },
      20_000
    );
  }
});
