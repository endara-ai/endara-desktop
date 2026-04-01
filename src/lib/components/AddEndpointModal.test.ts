import { describe, it, expect } from 'vitest';
import { sanitizeName, isValidToolPrefix } from '$lib/utils';

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

  it('returns null for empty string', () => {
    expect(sanitizeName('')).toBeNull();
  });

  it('returns null for only special characters', () => {
    expect(sanitizeName('@#$%^&*')).toBeNull();
  });

  it('strips unicode characters', () => {
    expect(sanitizeName('café')).toBe('caf');
    expect(sanitizeName('日本語')).toBeNull();
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

describe('isValidToolPrefix', () => {
  describe('valid prefixes', () => {
    it.each([
      'echo',
      'my-server',
      'test_ep',
      'a',
      '0day',
      'abc-123',
      'a-b_c',
      '9lives',
    ])('accepts "%s"', (prefix) => {
      expect(isValidToolPrefix(prefix)).toBe(true);
    });
  });

  describe('invalid prefixes', () => {
    it.each([
      ['', 'empty string'],
      ['-bad', 'starts with hyphen'],
      ['_bad', 'starts with underscore'],
      ['my server', 'contains space'],
      ['hello!', 'contains special character'],
      ['MY-SERVER', 'uppercase letters'],
    ])('rejects "%s" (%s)', (prefix) => {
      expect(isValidToolPrefix(prefix)).toBe(false);
    });
  });
});

