import { describe, it, expect } from 'vitest';

import { sanitizeName } from '$lib/prefix';

describe('sanitizeName', () => {
  it.each([
    ['echo-mcp', 'echo-mcp'],
    ['My MCP Server', 'my_mcp_server'],
    ['server@v2.0!', 'serverv20'],
    ['MyServer', 'myserver'],
    ['My Server - v2.0 (beta)', 'my_server_-_v20_beta'],
    ['café', 'caf'],
    ['日本語', ''],
    ['@#$%^&*', ''],
    ['', ''],
  ])('sanitizes "%s" to "%s"', (name, expected) => {
    expect(sanitizeName(name)).toBe(expected);
  });
});

