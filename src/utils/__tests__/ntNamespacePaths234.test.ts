import { describe, expect, test } from 'bun:test'
import {
  containsNtNamespacePath,
  detectAutomountPath,
  isAutomountPath,
  isNtNamespaceDevicePath,
  isNtNamespacePath,
  isNtObjectNamespacePath,
} from '../ntNamespacePaths.js'

// CC 2.1.234 NT-namespace path guards (binary Xw/Rys/Lwe/c6t, byte-verified).

describe('isNtNamespaceDevicePath (CC 2.1.234 Xw)', () => {
  test('matches leading \\??\\ and /??/ forms', () => {
    expect(isNtNamespaceDevicePath('\\??\\C:\\secret.txt')).toBe(true)
    expect(isNtNamespaceDevicePath('/??/C:/secret.txt')).toBe(true)
    expect(isNtNamespaceDevicePath('\\??\\PhysicalDrive0')).toBe(true)
  })

  test('rejects non-NT paths', () => {
    expect(isNtNamespaceDevicePath('C:\\Users\\me')).toBe(false)
    expect(isNtNamespaceDevicePath('/home/user/file')).toBe(false)
    expect(isNtNamespaceDevicePath('??\\leading')).toBe(false)
    expect(isNtNamespaceDevicePath('a\\??\\b')).toBe(false)
    expect(isNtNamespaceDevicePath('')).toBe(false)
  })
})

describe('isNtObjectNamespacePath (CC 2.1.234 Rys)', () => {
  test('matches object-manager namespaces case-insensitively', () => {
    expect(isNtObjectNamespacePath('\\GLOBAL??\\C:\\x')).toBe(true)
    expect(isNtObjectNamespacePath('\\global??\\x')).toBe(true)
    expect(isNtObjectNamespacePath('\\GLOBALROOT\\x')).toBe(true)
    expect(isNtObjectNamespacePath('\\DosDevices\\C:')).toBe(true)
    expect(isNtObjectNamespacePath('\\dosdevices\\x')).toBe(true)
    expect(isNtObjectNamespacePath('\\Device\\Harddisk0')).toBe(true)
    expect(isNtObjectNamespacePath('/Device/Harddisk0')).toBe(true)
  })

  test('rejects non-namespace paths', () => {
    expect(isNtObjectNamespacePath('\\Devices\\x')).toBe(false)
    expect(isNtObjectNamespacePath('C:\\GLOBALROOT\\x')).toBe(false)
    expect(isNtObjectNamespacePath('/home/Device/x')).toBe(false)
  })
})

describe('isNtNamespacePath (combined gate)', () => {
  test('covers both the device and object-manager forms', () => {
    expect(isNtNamespacePath('\\??\\C:\\x')).toBe(true)
    expect(isNtNamespacePath('\\Device\\x')).toBe(true)
    expect(isNtNamespacePath('/home/user/x')).toBe(false)
  })
})

describe('containsNtNamespacePath (CC 2.1.234 Lwe)', () => {
  test('catches direct device paths', () => {
    expect(containsNtNamespacePath('\\??\\C:\\x')).toBe(true)
  })

  test('catches \\??\\ produced by win32 normalization of mixed separators', () => {
    // e.g. `\..\??\..` style inputs normalize to a leading \??\ form
    expect(containsNtNamespacePath('/a/../\\??\\x')).toBe(true)
  })

  test('returns false for paths without any ?? sequence', () => {
    expect(containsNtNamespacePath('/normal/path')).toBe(false)
    expect(containsNtNamespacePath('C:\\normal\\path')).toBe(false)
  })

  test('returns false when ?? is present but normalization yields no device path', () => {
    expect(containsNtNamespacePath('/a/??/b')).toBe(false)
    expect(containsNtNamespacePath('file??name')).toBe(false)
  })
})

describe('detectAutomountPath (CC 2.1.234 c6t)', () => {
  test('detects /net/<share> prefixes', () => {
    expect(detectAutomountPath('/net/share/file')).toBe('/net/share')
    expect(detectAutomountPath('/net')).toBeNull()
    expect(detectAutomountPath('/net/share')).toBe('/net/share')
  })

  test('is case-insensitive on the net component', () => {
    expect(detectAutomountPath('/NET/share/x')).toBe('/NET/share')
    expect(detectAutomountPath('/Net/share')).toBe('/Net/share')
  })

  test('skips . segments and pops on ..', () => {
    expect(detectAutomountPath('/./net/share/x')).toBe('/net/share')
    expect(detectAutomountPath('/a/../net/share/x')).toBe('/net/share')
    expect(detectAutomountPath('/net/../other/share')).toBeNull()
  })

  test('rejects relative and non-net paths', () => {
    expect(detectAutomountPath('net/share')).toBeNull()
    expect(detectAutomountPath('/home/net/share')).toBeNull()
    expect(detectAutomountPath('/network/share')).toBeNull()
    expect(detectAutomountPath('')).toBeNull()
  })
})

describe('isAutomountPath (CC 2.1.234 bu)', () => {
  test('true exactly when detectAutomountPath finds a /net/<share> prefix', () => {
    expect(isAutomountPath('/net/share/file')).toBe(true)
    expect(isAutomountPath('/home/user')).toBe(false)
  })
})
