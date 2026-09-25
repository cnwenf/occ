import { describe, expect, test } from 'bun:test'
import {
  isAutomountBrowsePath,
  isKernelResolvedPathPrefix,
  isMacosNetworkMountSurfacePath,
  macosNetworkMountDenyMessage,
  shouldDenyMacosNetworkMountPath,
} from '../macosKernelPaths.js'

/**
 * CC 2.1.281 changelog #033 (security) — macOS automount / kernel-resolved
 * path prefix guards. Byte-verified against the v281 ELF:
 * - `UH(t)` kernel-resolved validator @192900730 (/.vol 0→15, /.nofollow
 *   0→10, /.resolve 0→10, "Kernel-resolved path prefix" 0→2)
 * - deny sentence @97322030 ("is under /net, /Network" 0→2)
 * - `iS`/`O`/`WW` automount validators (/net, /Network, /Network/Servers)
 */
describe('2.1.281 #033 — isKernelResolvedPathPrefix (binary UH @192900730)', () => {
  test('detects each kernel-resolved dotdir at the path root', () => {
    // Assert
    expect(isKernelResolvedPathPrefix('/.vol/1a2b/file.txt')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.file/2880189')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.nofollow/1/2')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.resolve/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.vol')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.resolve/')).toBe(true)
  })

  test('is case-insensitive (official regex carries /i)', () => {
    // Assert
    expect(isKernelResolvedPathPrefix('/.VOL/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/.Resolve/x')).toBe(true)
  })

  test('honors dot/.. normalization like the official walk ("/a/../.vol/x" counts)', () => {
    // Assert
    expect(isKernelResolvedPathPrefix('/a/../.vol/x')).toBe(true)
    expect(isKernelResolvedPathPrefix('/./.vol/x')).toBe(true)
  })

  test('rejects kernel dotdirs in deeper segments and ordinary paths', () => {
    // Assert
    expect(isKernelResolvedPathPrefix('/x/.vol/y')).toBe(false)
    expect(isKernelResolvedPathPrefix('/tmp/ordinary.txt')).toBe(false)
    expect(isKernelResolvedPathPrefix('/Users/me/.config')).toBe(false)
    expect(isKernelResolvedPathPrefix('relative/.vol/x')).toBe(false)
    expect(isKernelResolvedPathPrefix('.vol/x')).toBe(false)
  })
})

describe('2.1.281 #033 — isAutomountBrowsePath (binary iS/O/WW family)', () => {
  test('detects any depth under /net or /Network', () => {
    // Assert
    expect(isAutomountBrowsePath('/net')).toBe(true)
    expect(isAutomountBrowsePath('/net/host/share/file')).toBe(true)
    expect(isAutomountBrowsePath('/Network')).toBe(true)
    expect(isAutomountBrowsePath('/Network/Servers/host/x')).toBe(true)
    expect(isAutomountBrowsePath('/network/lowercase')).toBe(true)
  })

  test('rejects lookalikes that are not rooted at /net or /Network', () => {
    // Assert
    expect(isAutomountBrowsePath('/etc/net')).toBe(false)
    expect(isAutomountBrowsePath('/networks')).toBe(false)
    expect(isAutomountBrowsePath('/tmp/net/host')).toBe(false)
    expect(isAutomountBrowsePath('net/x')).toBe(false)
  })
})

describe('2.1.281 #033 — shouldDenyMacosNetworkMountPath (darwin gate)', () => {
  test('denies both surfaces on macos', () => {
    // Assert
    expect(shouldDenyMacosNetworkMountPath('/.vol/x', 'macos')).toBe(true)
    expect(shouldDenyMacosNetworkMountPath('/net/host', 'macos')).toBe(true)
    expect(
      shouldDenyMacosNetworkMountPath('/Network/Servers/h/p', 'macos'),
    ).toBe(true)
  })

  test('is a no-op on every non-darwin platform', () => {
    // Assert
    expect(shouldDenyMacosNetworkMountPath('/.vol/x', 'linux')).toBe(false)
    expect(shouldDenyMacosNetworkMountPath('/net/host', 'windows')).toBe(false)
    expect(shouldDenyMacosNetworkMountPath('/.vol/x', 'wsl')).toBe(false)
    expect(shouldDenyMacosNetworkMountPath('/net', 'unknown')).toBe(false)
  })

  test('allows ordinary paths on macos', () => {
    // Assert
    expect(shouldDenyMacosNetworkMountPath('/Users/me/proj', 'macos')).toBe(
      false,
    )
    expect(shouldDenyMacosNetworkMountPath('/tmp/f.txt', 'macos')).toBe(false)
  })

  test('isMacosNetworkMountSurfacePath is the platform-independent union', () => {
    // Assert
    expect(isMacosNetworkMountSurfacePath('/.file/x')).toBe(true)
    expect(isMacosNetworkMountSurfacePath('/net')).toBe(true)
    expect(isMacosNetworkMountSurfacePath('/tmp')).toBe(false)
  })
})

describe('2.1.281 #033 — macosNetworkMountDenyMessage (binary @97322030)', () => {
  test('produces the byte-exact official deny sentence', () => {
    // Arrange
    const path = '/.vol/deadbeef/secret.txt'

    // Act
    const message = macosNetworkMountDenyMessage(path)

    // Assert — sentence byte-verified against the v281 ELF attachment
    // validator `Urr` @97322030.
    expect(message).toBe(
      '"/.vol/deadbeef/secret.txt" is under /net, /Network, /.vol, /.file, /.nofollow or /.resolve, which could trigger a network mount, so it is not supported. Copy the file to an ordinary local path and pass that path instead.',
    )
  })
})
