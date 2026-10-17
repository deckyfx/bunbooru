import type { IngestGuardRegistry, JobService, MailService, SearchProviderRegistry } from "@bunbooru/core";

import type { PluginCapabilityBinding } from "./host";

/**
 * A plugin's mail transport follows its active state: installed on activate,
 * removed on deactivate, so deactivating mail immediately 503s the
 * reset/verify flows instead of lingering until a restart.
 */
export function mailBinding(mail: MailService): PluginCapabilityBinding {
  return {
    onActivate(plugin) {
      if (plugin.mailProvider) mail.setProvider(plugin.mailProvider, plugin.id);
    },
    onDeactivate(plugin) {
      if (plugin.mailProvider) mail.clearProvider(plugin.id);
    },
  };
}

/**
 * A plugin's search metatags (`fav:`, `pool:`) follow its active state, so a
 * deactivated plugin's terms are ignored immediately. A key colliding with a
 * Core metatag or another plugin's throws, which fails that activation (the
 * host then rolls the transition back).
 */
export function searchBinding(providers: SearchProviderRegistry): PluginCapabilityBinding {
  return {
    onActivate(plugin) {
      if (plugin.searchProviders.length > 0) providers.register(plugin.id, plugin.searchProviders);
    },
    onDeactivate(plugin) {
      providers.unregister(plugin.id);
    },
  };
}

/**
 * A plugin's job handlers follow its active state: while it's inactive its
 * jobs stay queued (nothing claims a kind with no handler) and resume when it
 * comes back. A kind another owner already handles fails that activation.
 */
export function jobsBinding(jobs: JobService): PluginCapabilityBinding {
  return {
    onActivate(plugin) {
      if (Object.keys(plugin.jobs).length > 0) jobs.register(plugin.id, plugin.jobs);
    },
    onDeactivate(plugin) {
      jobs.unregister(plugin.id);
    },
  };
}

/**
 * A plugin's upload checks follow its active state, so deactivating a guard
 * that misbehaves (guards fail closed) lets uploads through again at once.
 */
export function ingestGuardsBinding(guards: IngestGuardRegistry): PluginCapabilityBinding {
  return {
    onActivate(plugin) {
      if (plugin.ingestGuards.length > 0) guards.register(plugin.id, plugin.ingestGuards);
    },
    onDeactivate(plugin) {
      guards.unregister(plugin.id);
    },
  };
}
