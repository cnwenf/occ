// A plugin/marketplace item in the unified installed-plugins view. Fields are
// optional because individual sources (marketplace plugins, standalone MCPs,
// failed plugins) populate different subsets.
export interface UnifiedInstalledItem {
  name: string
  marketplace?: string
  enabled?: boolean
  installed?: boolean
  version?: string
  description?: string
  source?: string
  hasUpdate?: boolean
  id?: string
  type?: string
}
