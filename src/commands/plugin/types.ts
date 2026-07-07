// View-state machine for the /plugin settings panel. Discriminated union over
// the viewState.type literals used in PluginSettings.tsx.
import type { LocalJSXCommandOnDone } from '../../types/command.js'

export type ViewState =
  | { type: 'menu' }
  | { type: 'help' }
  | { type: 'discover-plugins' }
  | { type: 'manage-plugins' }
  | { type: 'manage-marketplaces' }
  | { type: 'manage-marketplace'; marketplace?: string }
  | { type: 'browse-marketplace'; marketplace?: string }
  | { type: 'add-marketplace' }
  | { type: 'marketplace-list' }
  | { type: 'marketplace-menu' }
  | { type: 'validate'; path?: string }

export interface PluginSettingsProps {
  onComplete: LocalJSXCommandOnDone
  args?: string
}
