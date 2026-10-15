import { describe, expect, test } from 'bun:test'
import {
  getWindowsSideMountPoints,
  isPathAtOrUnder,
  isWindowsSideMountFields,
  NATIVE_LINUX_FSTYPES,
  octalUnescapeMountPath,
  parseWindowsSideMountPoints,
  WINDOWS_SIDE_FSTYPES_WITH_MSDOS,
  WINDOWS_SIDE_MOUNT_FSTYPES,
  WslWindowsSideMountsUndeterminedError,
} from '../wslMounts.js'

/**
 * CC 2.1.299 #034 — WSL2 Windows-side mount detection (official `Cf`/`Of`/
 * `B5e`/`qIt`, byte-extracted from the v299 linux-x64 ELF @254393924 and
 * @220000886). Pure-function tests over fixture mount-table text — no mocks,
 * no /proc reads.
 */

// Realistic WSL2 /proc/mounts fixture (field order: source mountpoint fstype
// options dump pass; spaces inside paths are octal-escaped by the kernel).
const WSL2_MOUNTS_FIXTURE = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
  'devtmpfs /dev devtmpfs rw,nosuid,relatime 0 0',
  'tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0',
  '/dev/sda1 / ext4 rw,relatime,discard 0 0',
  'C:\\ /mnt/c drvfs rw,noatime,uid=1000,gid=1000 0 0',
  'D:\\ /mnt/d drvfs rw,noatime 0 0',
  'none /mnt/wslg 9p rw,relatime,cache=mmap,trans=fd,aname=drvfs;fmask=022 0 0',
  '\\\\wsl.localhost\\Ubuntu\\share /mnt/share cifs rw,relatime 0 0',
  '//fileserver/data /mnt/smb cifs rw 0 0',
  'host.example.com:/srv /mnt/nfs nfs4 rw,relatime 0 0',
  'sshfs#u@h:/x /mnt/ssh fuse.sshfs rw,nosuid 0 0',
  '/dev/sdb2 /home ext4 rw 0 0',
  'tmpfs /run tmpfs rw,nosuid 0 0',
].join('\n')

const NATIVE_ONLY_FIXTURE = [
  'sysfs /sys sysfs rw 0 0',
  '/dev/sda1 / ext4 rw 0 0',
  'tmpfs /tmp tmpfs rw 0 0',
  '/dev/sdb2 /home ext4 rw 0 0',
].join('\n')

describe('CC 2.1.299 #034 — parseWindowsSideMountPoints (official Cf)', () => {
  test('classifies drvfs, 9p-aname-drvfs, UNC, remote and fuse mounts as Windows-side', () => {
    expect(parseWindowsSideMountPoints(WSL2_MOUNTS_FIXTURE)).toEqual([
      '/mnt/c',
      '/mnt/d',
      '/mnt/wslg',
      '/mnt/share',
      '/mnt/smb',
      '/mnt/nfs',
      '/mnt/ssh',
    ])
  })

  test('native ext4/tmpfs/proc/sysfs/devtmpfs mounts are NOT Windows-side', () => {
    expect(parseWindowsSideMountPoints(NATIVE_ONLY_FIXTURE)).toEqual([])
  })

  test('octal-escapes in mount points are unescaped (official B5e)', () => {
    const table = 'C:\\ /mnt/c\\040one drvfs rw 0 0\nC:\\ /mnt/tab\\011x drvfs rw 0 0'
    expect(parseWindowsSideMountPoints(table)).toEqual([
      '/mnt/c one',
      '/mnt/tab\tx',
    ])
  })

  test('duplicate mount points are deduped (official D = [...new Set])', () => {
    const table = 'C:\\ /mnt/c drvfs rw 0 0\nC:\\ /mnt/c drvfs ro 0 0'
    expect(parseWindowsSideMountPoints(table)).toEqual(['/mnt/c'])
  })

  test('lines without an absolute mount point or without fstype are skipped', () => {
    const table = [
      '',
      'malformed',
      'C:\\ relative/mount drvfs rw 0 0',
      'C:\\ /mnt/only-three-fields',
    ].join('\n')
    expect(parseWindowsSideMountPoints(table)).toEqual([])
  })

  test('options field may be absent (undefined) without crashing', () => {
    expect(parseWindowsSideMountPoints('C:\\ /mnt/c drvfs')).toEqual(['/mnt/c'])
  })
})

describe('CC 2.1.299 #034 — isWindowsSideMountFields (official Cf predicate)', () => {
  const fields = (
    source: string,
    fstype: string,
    options = 'rw,relatime',
  ) => ({ source, mountPoint: '/mnt/x', fstype, options })

  test('every fstype in the official sl set matches', () => {
    for (const fstype of WINDOWS_SIDE_MOUNT_FSTYPES) {
      expect(isWindowsSideMountFields(fields('/dev/sdz', fstype))).toBe(true)
    }
  })

  test('fuse and fuse.<subtype> fstypes match (nt(fstype,".") === "fuse")', () => {
    expect(isWindowsSideMountFields(fields('/dev/sdz', 'fuse'))).toBe(true)
    expect(isWindowsSideMountFields(fields('/dev/sdz', 'fuse.sshfs'))).toBe(true)
    expect(isWindowsSideMountFields(fields('/dev/sdz', 'fusectl'))).toBe(false)
  })

  test('drive-letter sources match (C:\\ form)', () => {
    expect(isWindowsSideMountFields(fields('C:\\', 'unknownfs'))).toBe(true)
    expect(isWindowsSideMountFields(fields('d:\\files', 'unknownfs'))).toBe(true)
  })

  test('UNC sources match (\\\\ and // forms)', () => {
    expect(isWindowsSideMountFields(fields('\\\\host\\share', 'unknownfs'))).toBe(
      true,
    )
    expect(isWindowsSideMountFields(fields('//host/share', 'unknownfs'))).toBe(
      true,
    )
  })

  test('remote host:/path sources match (nfs-style)', () => {
    expect(isWindowsSideMountFields(fields('h.example.com:/x', 'unknownfs'))).toBe(
      true,
    )
  })

  test('aname=drvfs option matches with word boundary only', () => {
    expect(isWindowsSideMountFields(fields('none', 'unknownfs', 'aname=drvfs'))).toBe(
      true,
    )
    expect(
      isWindowsSideMountFields(fields('none', 'unknownfs', 'trans=fd,aname=drvfs;fmask=022')),
    ).toBe(true)
    expect(
      isWindowsSideMountFields(fields('none', 'unknownfs', 'xaname=drvfs')),
    ).toBe(false)
  })

  test('native fstype with native source and options is NOT Windows-side', () => {
    expect(isWindowsSideMountFields(fields('/dev/sda1', 'ext4'))).toBe(false)
    expect(isWindowsSideMountFields(fields('tmpfs', 'tmpfs'))).toBe(false)
  })
})

describe('CC 2.1.299 #034 — official sets (byte-exact forensics)', () => {
  test('sl set (Cf classifier) matches the v299 binary exactly', () => {
    expect([...WINDOWS_SIDE_MOUNT_FSTYPES]).toEqual([
      'drvfs',
      '9p',
      'virtiofs',
      'cifs',
      'smb3',
      'smbfs',
      'nfs',
      'nfs4',
      'ntfs',
      'ntfs3',
      'fuseblk',
      'vfat',
      'exfat',
    ])
  })

  test('Aa set (Rws classifier) = sl + msdos', () => {
    expect(WINDOWS_SIDE_FSTYPES_WITH_MSDOS.has('msdos')).toBe(true)
    expect(WINDOWS_SIDE_MOUNT_FSTYPES.has('msdos')).toBe(false)
  })

  test('hm native set spot-check (v299 @220000886)', () => {
    for (const fstype of ['ext4', 'btrfs', 'tmpfs', 'rootfs', 'squashfs', 'overlay-check']) {
      if (fstype === 'overlay-check') {
        expect(NATIVE_LINUX_FSTYPES.has(fstype)).toBe(false)
      } else {
        expect(NATIVE_LINUX_FSTYPES.has(fstype)).toBe(true)
      }
    }
    expect(NATIVE_LINUX_FSTYPES.has('nfsd')).toBe(true)
    expect(NATIVE_LINUX_FSTYPES.has('drvfs')).toBe(false)
  })
})

describe('CC 2.1.299 #034 — getWindowsSideMountPoints (official Of, fail-closed)', () => {
  test('returns Windows-side mount points from an injected reader', () => {
    expect(getWindowsSideMountPoints(() => WSL2_MOUNTS_FIXTURE)).toEqual([
      '/mnt/c',
      '/mnt/d',
      '/mnt/wslg',
      '/mnt/share',
      '/mnt/smb',
      '/mnt/nfs',
      '/mnt/ssh',
    ])
  })

  test('unreadable mount table refuses with the byte-exact official message', () => {
    let caught: unknown
    try {
      getWindowsSideMountPoints(() => {
        throw new Error('EACCES')
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WslWindowsSideMountsUndeterminedError)
    const refusal = caught as WslWindowsSideMountsUndeterminedError
    expect(refusal.message).toBe(
      "A shell tool was granted, but the WSL mount table (/proc/mounts) cannot be read, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.",
    )
    expect(refusal.reason).toBe(
      'the WSL mount table (/proc/mounts) cannot be read',
    )
  })

  test('no recognized Windows mount refuses with the byte-exact official message', () => {
    let caught: unknown
    try {
      getWindowsSideMountPoints(() => NATIVE_ONLY_FIXTURE)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WslWindowsSideMountsUndeterminedError)
    const refusal = caught as WslWindowsSideMountsUndeterminedError
    expect(refusal.message).toBe(
      "A shell tool was granted, but no Windows filesystem mount was recognized in the WSL mount table, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.",
    )
  })
})

describe('CC 2.1.299 #034 — octalUnescapeMountPath / isPathAtOrUnder (B5e / qIt)', () => {
  test('octal unescape', () => {
    expect(octalUnescapeMountPath('/mnt/c\\040one')).toBe('/mnt/c one')
    expect(octalUnescapeMountPath('/mnt/a\\134b')).toBe('/mnt/a\\b')
    expect(octalUnescapeMountPath('/plain/path')).toBe('/plain/path')
    expect(octalUnescapeMountPath('/two\\040\\040spaces')).toBe('/two  spaces')
  })

  test('path at-or-under prefix check with root special case', () => {
    expect(isPathAtOrUnder('/mnt/c', '/mnt/c')).toBe(true)
    expect(isPathAtOrUnder('/mnt/c/x', '/mnt/c')).toBe(true)
    expect(isPathAtOrUnder('/mnt/cd', '/mnt/c')).toBe(false)
    expect(isPathAtOrUnder('/mnt/cdx/y', '/mnt/c')).toBe(false)
    expect(isPathAtOrUnder('/anything', '/')).toBe(true)
    expect(isPathAtOrUnder('/', '/')).toBe(true)
  })
})
