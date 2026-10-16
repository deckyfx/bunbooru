import type { MailService, SearchProviderRegistry } from "@bunbooru/core";

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
