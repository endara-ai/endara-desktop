<!--
  Phase 2 placeholder. Renders a small magenta square anchored to the
  bottom-right of the overlay window so visual confirmation of
  "the overlay is alive and click-through" is possible during dev smoke.
  Phase 4 replaces this with the Toast Feed UI.
-->
<svelte:head>
  <title>Endara Overlay</title>
</svelte:head>

<div class="overlay-root">
  <div class="phase2-marker"></div>
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    background: transparent !important;
    color: transparent;
    overflow: hidden;
  }

  .overlay-root {
    position: fixed;
    inset: 0;
    background: transparent;
  }

  .phase2-marker {
    position: fixed;
    right: 24px;
    bottom: 24px;
    width: 100px;
    height: 100px;
    background-color: rgba(255, 0, 128, 0.6);
    border-radius: 12px;
    pointer-events: none;
  }
</style>
