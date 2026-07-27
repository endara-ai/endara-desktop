import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

describe('api', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockOk(data: unknown) {
    vi.mocked(invoke).mockResolvedValue({
      status: 200,
      body: JSON.stringify(data),
    });
  }

  function mockHttpError(status: number, body: string = '') {
    vi.mocked(invoke).mockResolvedValue({
      status,
      body,
    });
  }

  describe('getStatus', () => {
    it('fetches relay status via mgmt_api_request', async () => {
      const { getStatus } = await import('./api');
      const mockStatus = { status: 'ok', uptime_seconds: 100, endpoint_count: 2, healthy_count: 2 };
      mockOk(mockStatus);

      const result = await getStatus();
      expect(result).toEqual(mockStatus);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'GET', path: '/api/status' }),
      );
    });
  });

  describe('getEndpoints', () => {
    it('fetches endpoints list', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{ name: 'ep1', transport: 'stdio', health: 'healthy', tool_count: 3, last_activity: null }];
      mockOk(mockEndpoints);

      const result = await getEndpoints();
      expect(result).toEqual(mockEndpoints);
    });

    it('passes starting health through unchanged', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{ name: 'ep1', transport: 'stdio', health: 'starting', tool_count: 0, last_activity: null }];
      mockOk(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('starting');
    });

    it('maps lifecycle Failed state to error health with error message', async () => {
      const { getEndpoints } = await import('./api');
      const mockEndpoints = [{
        name: 'failed-ep',
        transport: 'stdio',
        health: 'healthy',
        tool_count: 0,
        last_activity: null,
        lifecycle: { state: 'Failed', error: { kind: 'Transport', detail: 'Connection refused' } },
      }];
      mockOk(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('error');
      expect(result[0].error).toBe('Connection refused');
      expect(result[0].lifecycle).toEqual({ state: 'Failed', error: { kind: 'Transport', detail: 'Connection refused' } });
    });

    it('preserves lifecycle Ready state without modifying health', async () => {
      const { getEndpoints } = await import('./api');
      const { getEndpointStatusLabel } = await import('./components/endpoint-row-helpers');
      const mockEndpoints = [{
        name: 'ready-ep',
        transport: 'stdio',
        health: 'healthy',
        tool_count: 5,
        last_activity: null,
        lifecycle: { state: 'Ready', server_name: 'my-server' },
      }];
      mockOk(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('healthy');
      expect(result[0].error).toBeUndefined();
      expect(result[0].lifecycle).toEqual({ state: 'Ready', server_name: 'my-server' });
      // Ready endpoints must keep showing the tool count — the Initializing
      // branch added in EndpointRow.svelte must not regress this case.
      expect(getEndpointStatusLabel(result[0])).toBe('5 tools');
    });

    it('handles lifecycle Initializing state', async () => {
      const { getEndpoints } = await import('./api');
      const { getEndpointStatusLabel } = await import('./components/endpoint-row-helpers');
      const mockEndpoints = [{
        name: 'init-ep',
        transport: 'stdio',
        health: 'starting',
        tool_count: 0,
        last_activity: null,
        lifecycle: { state: 'Initializing' },
      }];
      mockOk(mockEndpoints);

      const result = await getEndpoints();
      expect(result[0].health).toBe('starting');
      expect(result[0].lifecycle).toEqual({ state: 'Initializing' });
      // EndpointRow's secondary label must surface the transient state so a
      // freshly-spawned endpoint doesn't look like an empty "0 tools" server.
      expect(getEndpointStatusLabel(result[0])).toBe('Initializing…');
    });
  });

  describe('getEndpointTools', () => {
    it('fetches tools for endpoint', async () => {
      const { getEndpointTools } = await import('./api');
      const mockTools = [{ name: 'tool1', description: 'A tool' }];
      mockOk(mockTools);

      const result = await getEndpointTools('my-ep');
      expect(result).toEqual(mockTools);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ path: '/api/endpoints/my-ep/tools' }),
      );
    });
  });

  describe('addEndpoint', () => {
    it('POSTs the endpoint to the relay management API', async () => {
      const { addEndpoint } = await import('./api');
      mockOk(null);

      const params = { name: 'new-ep', transport: 'stdio' as const, command: '/usr/bin/my-mcp' };
      await addEndpoint(params);

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'POST', path: '/api/endpoints', body: params }),
      );
    });

    it('surfaces the relay error detail when the POST fails', async () => {
      const { addEndpoint } = await import('./api');
      mockHttpError(409, JSON.stringify({ detail: "endpoint 'new-ep' already exists" }));

      await expect(
        addEndpoint({ name: 'new-ep', transport: 'stdio', command: '/usr/bin/my-mcp' }),
      ).rejects.toThrow("endpoint 'new-ep' already exists");
    });

    it('omits client_secret from the create body and POSTs it to /credentials', async () => {
      const { addEndpoint } = await import('./api');
      vi.mocked(invoke)
        // POST /api/endpoints
        .mockResolvedValueOnce({ status: 201, body: '' })
        // POST /api/endpoints/{name}/credentials
        .mockResolvedValueOnce({ status: 204, body: '' });

      const params = {
        name: 'gmail',
        transport: 'oauth' as const,
        url: 'https://gmail.example.com/mcp',
        client_id: 'cid',
        client_secret: 'csecret',
        oauth_server_url: 'https://auth.example.com',
      };
      await addEndpoint(params);

      const { client_secret: _unused, ...expectedBody } = params;
      expect(invoke).toHaveBeenNthCalledWith(
        1,
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/endpoints',
          body: expectedBody,
        }),
      );
      expect(invoke).toHaveBeenNthCalledWith(
        2,
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/endpoints/gmail/credentials',
          body: {
            client_id: 'cid',
            client_secret: 'csecret',
            oauth_server_url: 'https://auth.example.com',
          },
        }),
      );
    });
  });

  describe('addEndpoint with env vars', () => {
    it('passes env vars through to the management API body', async () => {
      const { addEndpoint } = await import('./api');
      mockOk(null);

      const params = {
        name: 'github-server',
        transport: 'stdio' as const,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '$GITHUB_TOKEN', PLAIN_VAL: 'hello' },
      };
      await addEndpoint(params);

      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'POST', path: '/api/endpoints', body: params }),
      );
      const passedArgs = vi.mocked(invoke).mock.calls[0][1] as { body: typeof params };
      expect(passedArgs.body.env).toEqual({ GITHUB_TOKEN: '$GITHUB_TOKEN', PLAIN_VAL: 'hello' });
    });
  });

  describe('updateEndpoint', () => {
    it('PUTs to /api/endpoints/{original_name} without original_name or client_secret in the body', async () => {
      const { updateEndpoint } = await import('./api');
      mockOk(null);

      const params = {
        original_name: 'old-ep',
        name: 'new-ep',
        transport: 'stdio' as const,
        command: '/usr/bin/my-mcp',
        client_secret: 'csecret',
      };
      await updateEndpoint(params);

      const callBody = (vi.mocked(invoke).mock.calls[0][1] as { body: Record<string, unknown> }).body;
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'PUT', path: '/api/endpoints/old-ep' }),
      );
      expect(callBody).not.toHaveProperty('original_name');
      expect(callBody).not.toHaveProperty('client_secret');
      expect(callBody.name).toBe('new-ep');
    });

    it('encodes special characters in original_name in the path', async () => {
      const { updateEndpoint } = await import('./api');
      mockOk(null);

      await updateEndpoint({
        original_name: 'old ep/with space',
        name: 'new ep/with space',
        transport: 'stdio',
        command: '/usr/bin/my-mcp',
      });

      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'PUT',
          path: '/api/endpoints/old%20ep%2Fwith%20space',
        }),
      );
    });

    it('surfaces the relay error detail when the PUT fails', async () => {
      const { updateEndpoint } = await import('./api');
      mockHttpError(404, JSON.stringify({ detail: "endpoint 'old-ep' not found" }));

      await expect(
        updateEndpoint({
          original_name: 'old-ep',
          name: 'old-ep',
          transport: 'stdio',
          command: '/usr/bin/my-mcp',
        }),
      ).rejects.toThrow("endpoint 'old-ep' not found");
    });
  });

  describe('removeEndpoint', () => {
    it('calls invoke with correct command and name', async () => {
      const { removeEndpoint } = await import('./api');
      vi.mocked(invoke)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('relay not running'));

      await removeEndpoint('old-ep');

      expect(invoke).toHaveBeenCalledWith('remove_endpoint', { name: 'old-ep' });
    });
  });

  describe('getCatalog', () => {
    it('fetches the unified tool catalog', async () => {
      const { getCatalog } = await import('./api');
      const mockCatalog = [
        { name: 'm__ep1__tool1', description: 'A tool', inputSchema: { type: 'object' }, endpoint: 'ep1', available: true },
        { name: 'm__ep2__tool2', description: 'Another', inputSchema: { type: 'object' }, endpoint: 'ep2', available: false },
      ];
      mockOk(mockCatalog);

      const result = await getCatalog();
      expect(result).toEqual(mockCatalog);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ path: '/api/catalog' }),
      );
    });
  });

  describe('testConnection', () => {
    it('sends POST with connection params and returns success', async () => {
      const { testConnection } = await import('./api');
      const mockResult = { success: true, tool_count: 3, tools: ['a', 'b', 'c'] };
      mockOk(mockResult);

      const result = await testConnection({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      });
      expect(result).toEqual(mockResult);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'POST', path: '/api/test-connection' }),
      );
    });

    it('returns error result on connection failure', async () => {
      const { testConnection } = await import('./api');
      const mockResult = { success: false, error: 'Connection failed: spawn error' };
      mockOk(mockResult);

      const result = await testConnection({ transport: 'stdio', command: '/bad/cmd' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Connection failed');
    });

    it('throws on HTTP error', async () => {
      const { testConnection } = await import('./api');
      mockHttpError(500, 'Internal Server Error');

      await expect(testConnection({ transport: 'stdio', command: 'test' })).rejects.toThrow('HTTP 500');
    });

    it('parses tool names from successful response', async () => {
      const { testConnection } = await import('./api');
      const mockResult = {
        success: true,
        tool_count: 5,
        tools: ['read_file', 'write_file', 'list_dir', 'delete_file', 'move_file'],
      };
      mockOk(mockResult);

      const result = await testConnection({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        env: { HOME: '/tmp' },
      });
      expect(result.success).toBe(true);
      expect(result.tool_count).toBe(5);
      expect(result.tools).toHaveLength(5);
      expect(result.tools).toContain('read_file');
      expect(result.tools).toContain('move_file');
      const callBody = vi.mocked(invoke).mock.calls[0][1] as { body: { transport: string; command: string; args: string[]; env: Record<string, string> } };
      expect(callBody.body.transport).toBe('stdio');
      expect(callBody.body.command).toBe('npx');
      expect(callBody.body.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
      expect(callBody.body.env).toEqual({ HOME: '/tmp' });
    });
  });

  describe('error handling', () => {
    it('retries on transport failure and eventually throws', async () => {
      const { getStatus } = await import('./api');
      vi.mocked(invoke).mockRejectedValue(new Error('socket connect failed'));

      await expect(getStatus()).rejects.toThrow('socket connect failed');
      // Should have retried: 1 initial + 2 retries = 3 calls
      expect(invoke).toHaveBeenCalledTimes(3);
    });

    it('throws on HTTP error status after retries', async () => {
      const { getConfig } = await import('./api');
      mockHttpError(500, 'Internal Server Error');

      await expect(getConfig()).rejects.toThrow('HTTP 500');
    });
  });

  describe('oauthSetup', () => {
    // Regression coverage for the `server_type_override` field on
    // `OAuthSetupParams`. It must round-trip through `mgmt_api_request`'s
    // request body so the relay's `/oauth/setup` handler can persist it
    // alongside the rest of the endpoint config on commit.
    it('forwards server_type_override to invoke when set', async () => {
      const { oauthSetup } = await import('./api');
      mockOk({ session_id: 'sess-1', status: 'awaiting_callback' });

      await oauthSetup({
        name: 'Gmail',
        url: 'https://example.com/mcp/',
        server_type_override: 'gmail',
      });

      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/oauth/setup',
          body: expect.objectContaining({ server_type_override: 'gmail' }),
        }),
      );
    });

    it('omits server_type_override from invoke body when absent', async () => {
      const { oauthSetup } = await import('./api');
      mockOk({ session_id: 'sess-2', status: 'awaiting_callback' });

      await oauthSetup({
        name: 'Gmail',
        url: 'https://example.com/mcp/',
      });

      const callBody = vi.mocked(invoke).mock.calls[0][1] as { body: Record<string, unknown> };
      expect(callBody.body).not.toHaveProperty('server_type_override');
    });
  });

  describe('startOAuth', () => {
    // Regression coverage: the relay returns HTTP 502 with
    // `{"error":"discovery_unreachable","detail":...}` when RFC 8414 discovery
    // times out. It must pass through as a typed result (like dcr_unsupported /
    // discovery_failed) so reauthorize() can show the connectivity toast — not
    // fall into the generic non-2xx branch and throw.
    it('returns discovery_unreachable as a typed result instead of throwing on 502', async () => {
      const { startOAuth } = await import('./api');
      mockHttpError(
        502,
        JSON.stringify({
          error: 'discovery_unreachable',
          detail: 'Could not reach the OAuth server to discover its endpoints.',
        }),
      );

      const result = await startOAuth('sunsama');
      expect(result).toEqual({
        error: 'discovery_unreachable',
        detail: 'Could not reach the OAuth server to discover its endpoints.',
      });
    });

    it('returns dcr_unsupported as a typed result instead of throwing on 4xx', async () => {
      const { startOAuth } = await import('./api');
      mockHttpError(
        400,
        JSON.stringify({
          error: 'dcr_unsupported',
          detail: 'The OAuth server does not support Dynamic Client Registration.',
        }),
      );

      const result = await startOAuth('sunsama');
      expect(result).toEqual({
        error: 'dcr_unsupported',
        detail: 'The OAuth server does not support Dynamic Client Registration.',
      });
    });

    it('returns discovery_failed as a typed result instead of throwing on 400', async () => {
      const { startOAuth } = await import('./api');
      mockHttpError(
        400,
        JSON.stringify({
          error: 'discovery_failed',
          detail: 'OAuth discovery returned an invalid metadata document.',
        }),
      );

      const result = await startOAuth('sunsama');
      expect(result).toEqual({
        error: 'discovery_failed',
        detail: 'OAuth discovery returned an invalid metadata document.',
      });
    });

    it('throws on a 500 with an unrelated error body (generic non-2xx branch)', async () => {
      const { startOAuth } = await import('./api');
      mockHttpError(
        500,
        JSON.stringify({ error: 'internal_error', detail: 'unexpected relay failure' }),
      );

      await expect(startOAuth('sunsama')).rejects.toThrow('unexpected relay failure');
    });
  });

  describe('oauthProbe', () => {
    // The add-server flow relies on this probe being non-blocking: any
    // failure/timeout/non-2xx must resolve to `{ oauth_supported: false }`
    // (never throw) so the plain HTTP add can proceed silently.
    it('POSTs the url to /api/oauth/probe and returns the parsed result', async () => {
      const { oauthProbe } = await import('./api');
      mockOk({
        oauth_supported: true,
        authorization_server: 'https://auth.example.com',
        scopes_supported: ['read', 'write'],
      });

      const result = await oauthProbe('https://mcp.example.com/mcp');
      expect(result).toEqual({
        oauth_supported: true,
        authorization_server: 'https://auth.example.com',
        scopes_supported: ['read', 'write'],
      });
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/oauth/probe',
          body: { url: 'https://mcp.example.com/mcp' },
        }),
      );
    });

    it('resolves to oauth_supported:false on a non-2xx status without throwing', async () => {
      const { oauthProbe } = await import('./api');
      mockHttpError(500, 'Internal Server Error');

      const result = await oauthProbe('https://mcp.example.com/mcp');
      expect(result).toEqual({ oauth_supported: false });
    });

    it('resolves to oauth_supported:false on a transport error without retrying', async () => {
      const { oauthProbe } = await import('./api');
      vi.mocked(invoke).mockRejectedValue(new Error('socket connect failed'));

      const result = await oauthProbe('https://mcp.example.com/mcp');
      expect(result).toEqual({ oauth_supported: false });
      // Best-effort: a single attempt, no retry loop.
      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  describe('getIdpProviders', () => {
    it('GETs the provider template table', async () => {
      const { getIdpProviders } = await import('./api');
      const mockProviders = [
        { id: 'okta', name: 'Okta', issuer_pattern: 'https://{slug}.okta.com', slug_hint: 'subdomain' },
        { id: 'custom', name: 'Custom' },
      ];
      mockOk(mockProviders);

      const result = await getIdpProviders();
      expect(result).toEqual(mockProviders);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'GET', path: '/api/idp-providers' }),
      );
    });
  });

  describe('createOrganization', () => {
    it('POSTs the org params and returns the SSO authorize URL', async () => {
      const { createOrganization } = await import('./api');
      const mockResponse = {
        name: 'Acme Corp',
        provider: 'okta',
        idp: 'https://acme.okta.com',
        authorize_url: 'https://acme.okta.com/authorize?client_id=x',
      };
      vi.mocked(invoke).mockResolvedValue({ status: 201, body: JSON.stringify(mockResponse) });

      const params = { name: 'Acme Corp', provider: 'okta', slug: 'acme' };
      const result = await createOrganization(params);
      expect(result).toEqual(mockResponse);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'POST', path: '/api/organizations', body: params }),
      );
    });

    it('throws on a relay error status', async () => {
      const { createOrganization } = await import('./api');
      mockHttpError(409, JSON.stringify({ error: 'organization_exists' }));

      await expect(
        createOrganization({ name: 'Acme Corp', provider: 'okta', slug: 'acme' }),
      ).rejects.toThrow('HTTP 409');
    });
  });

  describe('listOrganizations', () => {
    it('GETs the configured organizations with auth status', async () => {
      const { listOrganizations } = await import('./api');
      const mockOrgs = [
        { name: 'Acme Corp', provider: 'okta', idp: 'https://acme.okta.com', authenticated: true },
      ];
      mockOk(mockOrgs);

      const result = await listOrganizations();
      expect(result).toEqual(mockOrgs);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'GET', path: '/api/organizations' }),
      );
    });
  });

  describe('createOrganization (client_secret)', () => {
    it('threads client_secret through the POST body', async () => {
      const { createOrganization } = await import('./api');
      const mockResponse = {
        name: 'Acme Corp',
        provider: 'okta',
        idp: 'https://acme.okta.com',
        authorize_url: 'https://acme.okta.com/authorize?client_id=x',
      };
      vi.mocked(invoke).mockResolvedValue({ status: 201, body: JSON.stringify(mockResponse) });

      const params = {
        name: 'Acme Corp',
        provider: 'okta',
        slug: 'acme',
        client_id: 'abc',
        client_secret: 's3cret',
      };
      await createOrganization(params);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'POST', path: '/api/organizations', body: params }),
      );
    });
  });

  describe('updateOrganization', () => {
    it('PUTs to the org path, URL-encoding the name', async () => {
      const { updateOrganization } = await import('./api');
      const mockResponse = {
        name: 'Acme Corp',
        provider: 'okta',
        idp: 'https://acme.okta.com',
        authenticated: true,
        client_secret_set: true,
      };
      mockOk(mockResponse);

      const params = { client_secret: 's3cret' };
      const res = await updateOrganization('Acme Corp', params);
      expect(res).toEqual(mockResponse);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'PUT',
          path: '/api/organizations/Acme%20Corp',
          body: params,
        }),
      );
    });

    it('returns the reauth response shape when the relay says identity changed', async () => {
      const { updateOrganization, updateRequiresReauth } = await import('./api');
      const mockResponse = {
        name: 'Acme Renamed',
        provider: 'okta',
        idp: 'https://acme.okta.com',
        authorize_url: 'https://acme.okta.com/authorize?client_id=x',
      };
      mockOk(mockResponse);

      const res = await updateOrganization('Acme Corp', { name: 'Acme Renamed' });
      expect(res).toEqual(mockResponse);
      expect(updateRequiresReauth(res)).toBe(true);
    });

    it('updateRequiresReauth is false when the response carries authenticated metadata', async () => {
      const { updateRequiresReauth } = await import('./api');
      expect(
        updateRequiresReauth({
          name: 'Acme',
          provider: 'okta',
          idp: 'https://acme.okta.com',
          authenticated: true,
        }),
      ).toBe(false);
    });

    it('throws on a relay error status', async () => {
      const { updateOrganization } = await import('./api');
      mockHttpError(404, JSON.stringify({ error: 'not_found' }));
      await expect(
        updateOrganization('Acme Corp', { client_secret: '' }),
      ).rejects.toThrow('HTTP 404');
    });
  });

  describe('deleteOrganization', () => {
    it('DELETEs the org, encoding the name in the path', async () => {
      const { deleteOrganization } = await import('./api');
      mockOk({ ok: true, name: 'Acme Corp' });

      await deleteOrganization('Acme Corp');
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({ method: 'DELETE', path: '/api/organizations/Acme%20Corp' }),
      );
    });
  });

  describe('reauthenticateOrganization', () => {
    it('POSTs to the reauthenticate route and returns a fresh SSO URL', async () => {
      const { reauthenticateOrganization } = await import('./api');
      const mockResponse = {
        name: 'Acme Corp',
        provider: 'custom',
        idp: 'https://acme.example.com',
        authorize_url: 'https://acme.example.com/authorize?client_id=x',
      };
      mockOk(mockResponse);

      const result = await reauthenticateOrganization('Acme Corp');
      expect(result).toEqual(mockResponse);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/organizations/Acme%20Corp/reauthenticate',
        }),
      );
    });
  });

  describe('probeOrganization', () => {
    it('POSTs the candidate resources and returns the per-resource results', async () => {
      const { probeOrganization } = await import('./api');
      const mockResponse = {
        results: [
          { resource: 'https://mcp.linear.app/mcp', status: 'accessible', server_as_issuer: 'https://linear.app' },
          { resource: 'https://mcp.slack.com/mcp', status: 'denied', server_as_issuer: 'https://slack.com' },
          { resource: 'https://mcp.asana.com/v2/mcp', status: 'unreachable' },
        ],
      };
      mockOk(mockResponse);

      const resources = [
        'https://mcp.linear.app/mcp',
        'https://mcp.slack.com/mcp',
        'https://mcp.asana.com/v2/mcp',
      ];
      const result = await probeOrganization('Acme Corp', resources);
      expect(result).toEqual(mockResponse);
      expect(invoke).toHaveBeenCalledWith(
        'mgmt_api_request',
        expect.objectContaining({
          method: 'POST',
          path: '/api/organizations/Acme%20Corp/probe',
          body: { resources },
        }),
      );
    });
  });
});

