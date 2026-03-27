<script lang="ts">
  let { transport }: { transport: string } = $props();

  const badgeColors: Record<string, string> = {
    stdio: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    sse: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
    http: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  };
</script>

<span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider {badgeColors[transport] ?? 'bg-gray-100 text-gray-600'}">
  {transport}
</span>

