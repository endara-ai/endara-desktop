import { describe, it, expect } from 'vitest';
import { sanitizeName } from '$lib/utils';

describe('sanitizeName', () => {
  it('handles basic lowercase name', () => {
    expect(sanitizeName('echo-mcp')).toBe('echo-mcp');
  });

  it('converts spaces to underscores', () => {
    expect(sanitizeName('My MCP Server')).toBe('my_mcp_server');
  });

  it('strips special characters', () => {
    expect(sanitizeName('server@v2.0!')).toBe('serverv20');
  });

  it('converts uppercase to lowercase', () => {
    expect(sanitizeName('MyServer')).toBe('myserver');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeName('')).toBe('');
  });

  it('returns empty string for only special characters', () => {
    expect(sanitizeName('@#$%^&*')).toBe('');
  });

  it('strips unicode characters', () => {
    expect(sanitizeName('café')).toBe('caf');
    expect(sanitizeName('日本語')).toBe('');
  });

  it('handles mixed input', () => {
    expect(sanitizeName('My Server - v2.0 (beta)')).toBe('my_server_-_v20_beta');
  });

  it('preserves hyphens and underscores', () => {
    expect(sanitizeName('my-server_name')).toBe('my-server_name');
  });

  it('preserves digits', () => {
    expect(sanitizeName('server123')).toBe('server123');
  });
});



