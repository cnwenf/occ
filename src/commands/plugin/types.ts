// View-state machine for the /plugin settings panel. Discriminated union over
// the viewState.type literals used in PluginSettings.tsx.
import type { LocalJSXCommandOnDone } from '../../types/command.js'

/**
 * Offer-to-add payload for the AddMarketplace confirmation UI (official 2.1.275
 * `confirmAdd` prop, ws@223945393 / jy@224148318). When present, AddMarketplace
 * shows "Add marketplace?" with y/n confirmation instead of auto-adding.
 * `plugin` is set for `/plugin install <plugin> --marketplace <source>` so the
 * post-add navigation targets that plugin; `linkOrigin` marks CLI/link entry.
 */
export interface ConfirmAddMarketplace {
  plugin?: string
  linkOrigin?: boolean
}

export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'discover-plugins'; targetPlugin?: string }
  | {
      type: 'manage-plugins'
      targetPlugin?: string
      targetMarketplace?: string
      action?: 'uninstall' | 'enable' | 'disable'
    }
  | {
      type: 'manage-marketplaces'
      targetMarketplace?: string
      action?: 'remove' | 'update'
    }
  | { type: 'manage-marketplace'; marketplace?: string }
  | {
      type: 'browse-marketplace'
      targetMarketplace?: string
      targetPlugin?: string
    }
  | {
      type: 'add-marketplace'
      initialValue?: string
      confirmAdd?: ConfirmAddMarketplace
    }
  | { type: 'marketplace-list' }
  | { type: 'marketplace-menu' }
  | { type: 'validate'; path?: string }

export interface PluginSettingsProps {
  onComplete: LocalJSXCommandOnDone
  args?: string
}
