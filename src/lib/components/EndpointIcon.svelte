<script lang="ts">
  import type { Endpoint } from '$lib/types';
  import { endpointIcon, STDIO_ICON, NETWORK_ICON } from '$lib/icons';

  let { endpoint, url, size = 20 }: { endpoint: Endpoint; url?: string; size?: number } = $props();

  let iconResult = $derived(endpointIcon(endpoint, url));
  let faviconFailed = $state(false);

  /** Fallback SVG when favicon fails to load */
  let fallbackSvg = $derived(endpoint.transport === 'stdio' ? STDIO_ICON : NETWORK_ICON);
</script>

{#if iconResult.type === 'svg' || faviconFailed}
  <span
    class="inline-flex items-center justify-center flex-shrink-0 text-(--color-text-secondary)"
    style="width: {size}px; height: {size}px;"
  >
    {@html faviconFailed ? fallbackSvg : iconResult.type === 'svg' ? iconResult.svg : ''}
  </span>
{:else}
  <img
    src={iconResult.url}
    alt="{endpoint.name} icon"
    width={size}
    height={size}
    class="flex-shrink-0 rounded"
    onerror={() => { faviconFailed = true; }}
  />
{/if}

