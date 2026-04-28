import type { Endpoint } from '$lib/types';

export type EndpointTransport = Endpoint['transport'];

export function shouldShowRestartButton(transport: EndpointTransport): boolean {
  return transport === 'stdio' || transport === 'sse';
}

