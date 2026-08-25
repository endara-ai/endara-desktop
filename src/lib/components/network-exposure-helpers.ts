// Pure helpers for the Settings "Network exposure" section: merge the
// relay-detected interface list with the configured `[relay] listen_ips`
// into displayable rows, and compute the next `listen_ips` list when a
// toggle flips. Kept out of Settings.svelte so the logic is unit-testable.

import type { NetworkInterfaceInfo } from '$lib/api';

/** One row in the Network exposure list (loopback is rendered separately). */
export interface NetworkExposureRow {
  /** The address as an IP literal. */
  ip: string;
  /** OS interface name; null when the IP is configured but not detected. */
  name: string | null;
  /** "private" | "cgnat" | "ula"; null when not detected. */
  kind: string | null;
  /** False for configured-but-undetected entries (e.g. Tailscale down). */
  detected: boolean;
  /** Whether the IP is currently in `listen_ips`. */
  enabled: boolean;
}

/**
 * Mirror of the relay's `listen_ips` eligibility classifier
 * (`endara_relay::listen_ips`): only RFC 1918, CGNAT (100.64.0.0/10), and
 * IPv6 ULA (fc00::/7) addresses may be rendered. Loopback, unspecified
 * (0.0.0.0 / ::), link-local, public, and unparseable entries are rejected
 * so the UI can never surface — let alone toggle on — an address the relay
 * itself refuses to bind.
 */
export function isRenderableListenIp(ip: string): boolean {
  const trimmed = ip.trim();
  const v4 = parseV4(trimmed);
  if (v4) return isEligibleV4(v4);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) classifies as its embedded IPv4.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mappedMatch) {
    const mapped = parseV4(mappedMatch[1]);
    return mapped !== null && isEligibleV4(mapped);
  }
  // IPv6: eligible only for ULA fc00::/7 (first hextet & 0xfe00 == 0xfc00).
  if (trimmed.includes(':')) {
    const first = trimmed.split(':', 1)[0];
    if (!/^[0-9a-f]{1,4}$/i.test(first)) return false;
    return (parseInt(first, 16) & 0xfe00) === 0xfc00;
  }
  return false;
}

function parseV4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

function isEligibleV4([a, b]: [number, number, number, number]): boolean {
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

/**
 * Merge detected interfaces with the configured `listen_ips` into rows:
 * detected interfaces first (API order) with `enabled` reflecting membership
 * in `listenIps`, then configured-but-undetected IPs as enabled rows marked
 * `detected: false` so the user can still turn them off. Entries from either
 * arm that are not renderable (loopback, 0.0.0.0, public, garbage) are
 * dropped — the relay already filters detected interfaces, but the helper
 * re-checks them as defense in depth; duplicates keep their first occurrence.
 */
export function buildNetworkExposureRows(
  interfaces: NetworkInterfaceInfo[],
  listenIps: string[],
): NetworkExposureRow[] {
  const rows: NetworkExposureRow[] = [];
  const seen = new Set<string>();
  const configured = new Set(listenIps.map((ip) => ip.trim()));
  for (const iface of interfaces) {
    if (seen.has(iface.ip) || !isRenderableListenIp(iface.ip)) continue;
    seen.add(iface.ip);
    rows.push({
      ip: iface.ip,
      name: iface.name,
      kind: iface.kind,
      detected: true,
      enabled: configured.has(iface.ip),
    });
  }
  for (const raw of listenIps) {
    const ip = raw.trim();
    if (seen.has(ip) || !isRenderableListenIp(ip)) continue;
    seen.add(ip);
    rows.push({ ip, name: null, kind: null, detected: false, enabled: true });
  }
  return rows;
}

/**
 * Compute the next `listen_ips` list after toggling `ip`. Enabling appends
 * (no duplicate); disabling removes every occurrence. Order of the remaining
 * entries is preserved.
 */
export function toggleListenIp(
  listenIps: string[],
  ip: string,
  enabled: boolean,
): string[] {
  const without = listenIps.filter((entry) => entry.trim() !== ip);
  return enabled ? [...without, ip] : without;
}
