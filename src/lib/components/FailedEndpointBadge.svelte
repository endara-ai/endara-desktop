<script lang="ts">
  let { error }: { error: string } = $props();
</script>

<span
  class="inline-flex items-center justify-center w-4 h-4 text-red-500"
  title={error}
>
  <svg
    class="w-3.5 h-3.5"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <!-- Triangle warning icon -->
    <path d="M8 5.5v3.5" />
    <circle cx="8" cy="11.5" r="0.75" fill="currentColor" stroke="none" />
    <path d="M3 13.5L8 3l5 10.5H3z" />
  </svg>
</span>

