import { describe, it, expect } from 'vitest';
import {
  shouldShowRestartButton,
  shouldShowRefreshButton,
  visibleTabs,
  type EndpointTransport,
} from './detail-panel-helpers';

describe('shouldShowRestartButton', () => {
  const cases: Array<[EndpointTransport, boolean]> = [
    ['stdio', true],
    ['sse', true],
    ['http', false],
    ['oauth', false],
  ];

  for (const [transport, expected] of cases) {
    it(`returns ${expected} for transport "${transport}" when enabled`, () => {
      expect(shouldShowRestartButton(transport, false)).toBe(expected);
    });
  }

  describe('when disabled', () => {
    const transports: EndpointTransport[] = ['stdio', 'sse', 'http', 'oauth'];
    for (const transport of transports) {
      it(`returns false for transport "${transport}" when disabled`, () => {
        expect(shouldShowRestartButton(transport, true)).toBe(false);
      });
    }
  });
});

describe('shouldShowRefreshButton', () => {
  it('returns true when enabled', () => {
    expect(shouldShowRefreshButton(false)).toBe(true);
  });
  it('returns false when disabled', () => {
    expect(shouldShowRefreshButton(true)).toBe(false);
  });
});

describe('visibleTabs', () => {
  it('returns tools, logs, config for stdio when enabled', () => {
    expect(visibleTabs('stdio', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
    ]);
  });

  it('returns tools, logs, config for http when enabled', () => {
    expect(visibleTabs('http', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
    ]);
  });

  it('returns tools, logs, config, auth for oauth when enabled', () => {
    expect(visibleTabs('oauth', false)).toEqual([
      { id: 'tools', label: 'Tools' },
      { id: 'logs', label: 'Logs' },
      { id: 'config', label: 'Config' },
      { id: 'auth', label: 'Auth' },
    ]);
  });

  it('returns config only for stdio when disabled', () => {
    expect(visibleTabs('stdio', true)).toEqual([{ id: 'config', label: 'Config' }]);
  });

  it('returns config, auth for oauth when disabled', () => {
    expect(visibleTabs('oauth', true)).toEqual([
      { id: 'config', label: 'Config' },
      { id: 'auth', label: 'Auth' },
    ]);
  });

  it('preserves stable tab order across transports when enabled', () => {
    const order = (t: EndpointTransport) => visibleTabs(t, false).map((tab) => tab.id);
    expect(order('stdio')).toEqual(['tools', 'logs', 'config']);
    expect(order('sse')).toEqual(['tools', 'logs', 'config']);
    expect(order('http')).toEqual(['tools', 'logs', 'config']);
    expect(order('oauth')).toEqual(['tools', 'logs', 'config', 'auth']);
  });
});

