<script>
  import '../app.css';
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { checkForUpdate } from '$lib/updater';
  import { Toaster } from 'svelte-sonner';

  let { children } = $props();

  onMount(() => {
    // Check for updates 5s after launch
    const initialTimeout = setTimeout(() => checkForUpdate(), 5000);

    // Re-check every 4 hours
    const interval = setInterval(() => checkForUpdate(), 4 * 60 * 60 * 1000);

    // Listen for tray "Check for Updates" event
    const unlisten = listen('check-for-update', () => {
      checkForUpdate();
    });

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
      unlisten.then((fn) => fn());
    };
  });
</script>

<Toaster position="bottom-right" duration={5000} richColors closeButton />
{@render children()}

