<!--
  Hint pill rendered next to a server name on overlay cards. Tone is driven
  by the annotation kind (destructive=danger, open-world=warn,
  read-only/idempotent=muted). Styling lives in `overlay.css`.
-->
<script lang="ts">
  import type { HintMeta } from './overlay-helpers';

  type Props = { hint: HintMeta };
  let { hint }: Props = $props();
</script>

<span class="tf-pill" data-tone={hint.tone} data-kind={hint.kind}>{hint.label}</span>
