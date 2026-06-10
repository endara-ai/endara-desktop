import { describe, it, expect } from 'vitest';
import type { ParsedLogLine } from '$lib/logParser';
import { relayEventDetail } from './relay-event-detail';

// Minimal ParsedLogLine factory — only the fields the detail helper reads
// matter; the rest carry harmless defaults.
function line(overrides: Partial<ParsedLogLine>): ParsedLogLine {
  return {
    timestamp: new Date('2026-06-10T00:00:00.000Z'),
    level: 'info',
    message: '',
    raw: '',
    isToolCall: false,
    ...overrides,
  };
}

describe('relayEventDetail — MCP request', () => {
  it('joins method, status, elapsed, and caller', () => {
    const detail = relayEventDetail(
      line({
        message: 'MCP request',
        method: 'tools/call',
        status: '200',
        elapsedMs: 42,
        clientName: 'LiveTest JSON Logs',
        clientVersion: '2.0.0',
      }),
    );
    expect(detail).toBe('MCP request · tools/call · 200 · 42ms · LiveTest JSON Logs 2.0.0');
  });

  it('omits each segment when its field is absent', () => {
    expect(relayEventDetail(line({ message: 'MCP request' }))).toBe('MCP request');
    expect(relayEventDetail(line({ message: 'MCP request', method: 'initialize' }))).toBe(
      'MCP request · initialize',
    );
    expect(
      relayEventDetail(line({ message: 'MCP request', elapsedMs: 7, clientName: 'Cursor' })),
    ).toBe('MCP request · 7ms · Cursor');
  });

  it('uses the name only when the caller version is missing', () => {
    expect(
      relayEventDetail(line({ message: 'MCP request', method: 'tools/list', clientName: 'Cursor' })),
    ).toBe('MCP request · tools/list · Cursor');
  });

  it('drops a NaN elapsedMs segment', () => {
    expect(relayEventDetail(line({ message: 'MCP request', elapsedMs: Number.NaN }))).toBe(
      'MCP request',
    );
  });
});

describe('relayEventDetail — Routing tool call', () => {
  it('renders prefixed tool → endpoint', () => {
    expect(
      relayEventDetail(
        line({
          message: 'Routing tool call',
          prefixed: 'atlassian__getAccessibleAtlassianResources',
          tool: 'getAccessibleAtlassianResources',
          endpoint: 'Atlassian',
        }),
      ),
    ).toBe('Routing tool call · atlassian__getAccessibleAtlassianResources → Atlassian');
  });

  it('falls back to the bare tool when prefixed is absent', () => {
    expect(
      relayEventDetail(line({ message: 'Routing tool call', tool: 'send_email', endpoint: 'Gmail' })),
    ).toBe('Routing tool call · send_email → Gmail');
  });

  it('omits the endpoint tail when endpoint is absent', () => {
    expect(relayEventDetail(line({ message: 'Routing tool call', prefixed: 'gh__list' }))).toBe(
      'Routing tool call · gh__list',
    );
  });

  it('renders the bare label when neither tool nor endpoint is present', () => {
    expect(relayEventDetail(line({ message: 'Routing tool call' }))).toBe('Routing tool call');
  });
});

describe('relayEventDetail — other lines', () => {
  it('returns null for any other message so the row renders unchanged', () => {
    expect(relayEventDetail(line({ message: 'Tool call completed', tool: 'x' }))).toBeNull();
    expect(relayEventDetail(line({ message: 'Relay listening on 127.0.0.1:47107' }))).toBeNull();
    expect(relayEventDetail(line({ message: '' }))).toBeNull();
  });
});
