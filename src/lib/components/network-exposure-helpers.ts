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
 * itself refuses to bind. IPv6 literals are fully parsed (hextet syntax,
 * group count, at most one `::`), so a malformed string that merely starts
 * with a ULA-looking hextet (`fd00:junk`, `fc00:`) is rejected too.
 */
export function isRenderableListenIp(ip: string): boolean {
  const trimmed = ip.trim();
  const v4 = parseV4(trimmed);
  if (v4) return isEligibleV4(v4);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) classifies as its embedded IPv4.
  const mapped = parseMappedV4(trimmed);
  if (mapped) return isEligibleV4(mapped);
  // IPv6: eligible only for ULA fc00::/7 (first hextet & 0xfe00 == 0xfc00).
  const segments = parseV6(trimmed);
  return segments !== null && (segments[0] & 0xfe00) === 0xfc00;
}

/**
 * Normalize an IP literal to a canonical textual form so that equivalent
 * spellings compare equal: whitespace is trimmed, IPv4 octets lose leading
 * zeros, and IPv6 is lowercased and compressed per RFC 5952 (`fd00:0::1`,
 * `FD00:0:0:0:0:0:0:1`, and `fd00::1` all normalize to `fd00::1`). Returns
 * null when the input is not a parseable IPv4/IPv6 literal. Used for both
 * row comparison and the persisted `listen_ips` entries.
 */
export function normalizeListenIp(ip: string): string | null {
  const trimmed = ip.trim();
  const v4 = parseV4(trimmed);
  if (v4) return v4.join('.');
  const mapped = parseMappedV4(trimmed);
  if (mapped) return `::ffff:${mapped.join('.')}`;
  const segments = parseV6(trimmed);
  return segments !== null ? formatV6(segments) : null;
}

function parseV4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

function parseMappedV4(s: string): [number, number, number, number] | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? parseV4(m[1]) : null;
}

/**
 * Parse an IPv6 literal into its 8 hextets, or null when malformed: every
 * group must be 1-4 hex digits, at most one `::` (which must stand in for at
 * least one zero group), and the group count must come out to exactly 8.
 * Embedded-IPv4 tails (`fd00::1.2.3.4`) are not supported; the relay always
 * reports pure-hex forms.
 */
function parseV6(s: string): number[] | null {
  if (!s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (half: string): number[] | null => {
    if (half === '') return [];
    const groups = half.split(':');
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseGroups(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Format 8 hextets per RFC 5952: lowercase hex, longest zero run (≥2) as `::`. */
function formatV6(segments: number[]): string {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (segments[i] === 0) {
      let j = i;
      while (j < 8 && segments[j] === 0) j++;
      if (j - i > bestLen) {
        best = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i++;
    }
  }
  const hex = segments.map((seg) => seg.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
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
 * re-checks them as defense in depth. All comparison, de-duping, and row keys
 * use `normalizeListenIp`, so equivalent spellings (whitespace, IPv6 case or
 * zero-compression variants) collapse into one row; duplicates keep their
 * first occurrence.
 */
export function buildNetworkExposureRows(
  interfaces: NetworkInterfaceInfo[],
  listenIps: string[],
): NetworkExposureRow[] {
  const rows: NetworkExposureRow[] = [];
  const seen = new Set<string>();
  const configured = new Set(
    listenIps
      .map((ip) => normalizeListenIp(ip))
      .filter((ip): ip is string => ip !== null),
  );
  for (const iface of interfaces) {
    const ip = normalizeListenIp(iface.ip);
    if (ip === null || seen.has(ip) || !isRenderableListenIp(ip)) continue;
    seen.add(ip);
    rows.push({
      ip,
      name: iface.name,
      kind: iface.kind,
      detected: true,
      enabled: configured.has(ip),
    });
  }
  for (const raw of listenIps) {
    const ip = normalizeListenIp(raw);
    if (ip === null || seen.has(ip) || !isRenderableListenIp(ip)) continue;
    seen.add(ip);
    rows.push({ ip, name: null, kind: null, detected: false, enabled: true });
  }
  return rows;
}

/**
 * Compute the next `listen_ips` list after toggling `ip`. Enabling appends
 * the normalized form (no duplicate); disabling removes every occurrence
 * whose normalized form matches, so non-canonical spellings of the same
 * address (e.g. `fd00:0::1` vs `fd00::1`) are removed too. Order of the
 * remaining entries is preserved.
 */
export function toggleListenIp(
  listenIps: string[],
  ip: string,
  enabled: boolean,
): string[] {
  const target = normalizeListenIp(ip) ?? ip.trim();
  const without = listenIps.filter(
    (entry) => (normalizeListenIp(entry) ?? entry.trim()) !== target,
  );
  return enabled ? [...without, target] : without;
}
