<script lang="ts">
    import { Settings, GlobalSettings } from '../../stores/Settings.svelte';
    import { FrontendResourceKey as R } from '../../../../i18n/ILocale';
</script>

<label title={GlobalSettings.Locale[R.Frontend_Classic_Settings_ArabicFirstInfo]()}>
    <input type="checkbox" data-testid="arabic-first-preference" bind:checked={Settings.ArabicFirstPlugins.Value} />
    {GlobalSettings.Locale[R.Frontend_Classic_Settings_ArabicFirst]()}
</label>

<style>
    label { display: flex; align-items: center; gap: .5rem; padding: .5rem 0; font-size: .875rem; cursor: pointer; }
    input { accent-color: var(--cds-interactive-01); }
</style>
