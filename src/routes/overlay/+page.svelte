<!--
  Phase 4: render the real Toast Feed overlay. All theme/CSS/pointer-event
  plumbing lives in `OverlayApp` so this route is just a thin mount point.
-->
<script lang="ts">
  import OverlayApp from '$lib/overlay/OverlayApp.svelte';
</script>

<OverlayApp />
