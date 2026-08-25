import { describe, expect, it } from 'vitest';

import {
  buildNetworkExposureRows,
  isRenderableListenIp,
  toggleListenIp,
} from './network-exposure-helpers';
import type { NetworkInterfaceInfo } from '$lib/api';

const eth0: NetworkInterfaceInfo = { name: 'eth0', ip: '192.168.1.5', family: 'v4', kind: 'private' };
const tailscale: NetworkInterfaceInfo = { name: 'tailscale0', ip: '100.101.102.103', family: 'v4', kind: 'cgnat' };

describe('isRenderableListenIp', () => {
  it('accepts RFC 1918, CGNAT, and ULA addresses', () => {
    expect(isRenderableListenIp('10.0.0.1')).toBe(true);
    expect(isRenderableListenIp('172.16.0.1')).toBe(true);
    expect(isRenderableListenIp('172.31.255.254')).toBe(true);
    expect(isRenderableListenIp('192.168.1.5')).toBe(true);
    expect(isRenderableListenIp('100.64.0.1')).toBe(true);
    expect(isRenderableListenIp('100.127.255.254')).toBe(true);
    expect(isRenderableListenIp('fd12:3456:789a::1')).toBe(true);
  });

  it('rejects loopback, unspecified, link-local, and public addresses', () => {
    expect(isRenderableListenIp('127.0.0.1')).toBe(false);
    expect(isRenderableListenIp('0.0.0.0')).toBe(false);
    expect(isRenderableListenIp('::')).toBe(false);
    expect(isRenderableListenIp('::1')).toBe(false);
    expect(isRenderableListenIp('169.254.1.1')).toBe(false);
    expect(isRenderableListenIp('fe80::1')).toBe(false);
    expect(isRenderableListenIp('8.8.8.8')).toBe(false);
    expect(isRenderableListenIp('100.63.255.255')).toBe(false);
    expect(isRenderableListenIp('172.32.0.1')).toBe(false);
    expect(isRenderableListenIp('2001:db8::1')).toBe(false);
    expect(isRenderableListenIp('not-an-ip')).toBe(false);
    expect(isRenderableListenIp('')).toBe(false);
  });

  it('classifies IPv4-mapped IPv6 by the embedded IPv4 address', () => {
    expect(isRenderableListenIp('::ffff:192.168.1.10')).toBe(true);
    expect(isRenderableListenIp('::ffff:8.8.8.8')).toBe(false);
    expect(isRenderableListenIp('::ffff:127.0.0.1')).toBe(false);
  });
});

describe('buildNetworkExposureRows', () => {
  it('marks detected interfaces enabled based on listen_ips membership', () => {
    const rows = buildNetworkExposureRows([eth0, tailscale], ['100.101.102.103']);
    expect(rows).toEqual([
      { ip: '192.168.1.5', name: 'eth0', kind: 'private', detected: true, enabled: false },
      { ip: '100.101.102.103', name: 'tailscale0', kind: 'cgnat', detected: true, enabled: true },
    ]);
  });

  it('appends configured-but-undetected IPs as enabled "not detected" rows', () => {
    const rows = buildNetworkExposureRows([eth0], ['100.101.102.103']);
    expect(rows).toEqual([
      { ip: '192.168.1.5', name: 'eth0', kind: 'private', detected: true, enabled: false },
      { ip: '100.101.102.103', name: null, kind: null, detected: false, enabled: true },
    ]);
  });

  it('never renders configured loopback, unspecified, or public IPs', () => {
    const rows = buildNetworkExposureRows(
      [eth0],
      ['127.0.0.1', '0.0.0.0', '::', '8.8.8.8', 'garbage', '192.168.1.5'],
    );
    expect(rows).toEqual([
      { ip: '192.168.1.5', name: 'eth0', kind: 'private', detected: true, enabled: true },
    ]);
  });

  it('never renders ineligible DETECTED interfaces (defense in depth vs the API)', () => {
    const rows = buildNetworkExposureRows(
      [
        { name: 'any0', ip: '0.0.0.0', family: 'v4', kind: 'private' },
        { name: 'lo', ip: '127.0.0.1', family: 'v4', kind: 'private' },
        { name: 'wan0', ip: '8.8.8.8', family: 'v4', kind: 'private' },
      ],
      [],
    );
    expect(rows).toEqual([]);
  });

  it('a detected 127.0.0.1 never duplicates the always-on Localhost row, even when configured', () => {
    const rows = buildNetworkExposureRows(
      [{ name: 'lo', ip: '127.0.0.1', family: 'v4', kind: 'private' }, eth0],
      ['127.0.0.1'],
    );
    expect(rows).toEqual([
      { ip: '192.168.1.5', name: 'eth0', kind: 'private', detected: true, enabled: false },
    ]);
  });

  it('dedupes repeated interfaces and configured entries, trimming whitespace', () => {
    const rows = buildNetworkExposureRows(
      [eth0, eth0],
      [' 10.0.0.7 ', '10.0.0.7'],
    );
    expect(rows).toEqual([
      { ip: '192.168.1.5', name: 'eth0', kind: 'private', detected: true, enabled: false },
      { ip: '10.0.0.7', name: null, kind: null, detected: false, enabled: true },
    ]);
  });

  it('returns an empty list when nothing is detected or configured', () => {
    expect(buildNetworkExposureRows([], [])).toEqual([]);
  });
});

describe('toggleListenIp', () => {
  it('enabling appends the IP to the configured list', () => {
    expect(toggleListenIp(['10.0.0.7'], '192.168.1.5', true)).toEqual([
      '10.0.0.7',
      '192.168.1.5',
    ]);
  });

  it('enabling an already-present IP does not duplicate it', () => {
    expect(toggleListenIp(['192.168.1.5'], '192.168.1.5', true)).toEqual(['192.168.1.5']);
  });

  it('disabling removes every occurrence, preserving remaining order', () => {
    expect(
      toggleListenIp(['10.0.0.7', '192.168.1.5', ' 192.168.1.5 '], '192.168.1.5', false),
    ).toEqual(['10.0.0.7']);
  });

  it('disabling an absent IP leaves the list unchanged', () => {
    expect(toggleListenIp(['10.0.0.7'], '192.168.1.5', false)).toEqual(['10.0.0.7']);
  });

  it('does not mutate the input list', () => {
    const input = ['10.0.0.7'];
    toggleListenIp(input, '192.168.1.5', true);
    toggleListenIp(input, '10.0.0.7', false);
    expect(input).toEqual(['10.0.0.7']);
  });
});
