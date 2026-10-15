/**
 * WSL2 Windows-side mount detection and fail-closed refusal (CC 2.1.299 #034).
 *
 * On WSL2 the Windows drives are mounted into the Linux namespace (drvfs/9p
 * mounts like `C:\ /mnt/c drvfs ...`). bwrap cannot always create mount
 * points on those filesystems — the reported upstream failure is
 * `bwrap: Can't mkdir /mnt/c/Program Files/ClaudeCode` — because a mkdir on
 * the Windows side can be refused (e.g. under `Program Files` without
 * admin rights, or on drives mounted without metadata support). Official
 * 2.1.299 therefore classifies every /proc/mounts entry as Windows-side or
 * native, refuses the run when the Windows side cannot be determined, and
 * keeps sandbox mount-point creation off Windows-drive mounts.
 *
 * Forensic map (official v299 linux-x64 ELF, byte-extract verified):
 * - `sl` set @254393924 region (the `Cf` classifier set) — mirrored below as
 *   WINDOWS_SIDE_MOUNT_FSTYPES.
 * - `Cf` (the /proc/mounts scan) @254393924: splits each line on " " into
 *   [source, mountPoint, fstype, options], requires a posix-absolute mount
 *   point, classifies via `sl.has(fstype) || sl.has(nt(fstype,".")) ||
 *   nt(fstype,".")==="fuse"` plus the source/options regexes, octal-unescapes
 *   the mount point (`B5e`) and dedupes (`D(n) = [...new Set(n)]`).
 * - `Of` (fail-closed reader) @254393924: reads /proc/mounts, refuses with
 *   the byte-exact message below when the table is unreadable or when no
 *   Windows filesystem mount was recognized.
 * - `nt(t,n)` @ (shared helper): `let e=t.indexOf(n); return e===-1?t:t.slice(0,e)`
 *   — the substring before the first delimiter.
 * - `B5e` @220000886: `e.replace(/\\([0-7]{3})/g,(n,r)=>String.fromCharCode(parseInt(r,8)))`
 *   — /proc/mounts octal-escapes special characters (\040 for space, etc).
 * - `qIt` @220001791 region: `e===n||e.startsWith(n==="/"?"/":`${n}/`)`
 *   — path-at-or-under prefix check with a root special case.
 * - Related production-side sets @220000886 (context only; the refusal path
 *   uses the `sl` set): `Aa` = "drvfs 9p virtiofs cifs smb3 smbfs nfs nfs4
 *   ntfs ntfs3 fuseblk vfat exfat msdos" and the native set `hm` =
 *   "ext2 ext3 ext4 xfs btrfs zfs f2fs jfs reiserfs nilfs2 bcachefs tmpfs
 *   ramfs rootfs squashfs erofs" + "proc sysfs devtmpfs devpts mqueue
 *   hugetlbfs cgroup cgroup2 pstore bpf debugfs tracefs securityfs" +
 *   "configfs fusectl binfmt_misc nsfs rpc_pipefs efivarfs selinuxfs nfsd".
 *
 * Official note: the refusal family lives in the official EVAL sandbox setup
 * (`let V=O()==="wsl"?await Of(h):[]`, error tag "eval: WSL Windows-side
 * mounts undetermined"); the production WSL machinery around @220000886
 * (`Rws`/`xws`/secondRootMounts) shares the same sets and regexes. OCC
 * applies the Cf/Of semantics at the CLI sandbox-adapter layer for every
 * sandboxed shell command; the refusal message text is kept byte-exact while
 * the eval-only error tag is not reproduced (documented divergence).
 */

import { readFileSync } from 'fs'
import { isAbsolute as isPosixAbsolute } from 'path/posix'

/**
 * Official `sl` set (v299 @254393924 region) — the fstypes the /proc/mounts
 * classifier (`Cf`) treats as Windows-side/network filesystems.
 */
export const WINDOWS_SIDE_MOUNT_FSTYPES: ReadonlySet<string> = new Set([
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

/**
 * Official `Aa` set (v299 @220000886, production `Rws` classifier) — the
 * Windows-side/remote set including `msdos`. Exported for parity/tooling;
 * the refusal path itself uses WINDOWS_SIDE_MOUNT_FSTYPES (`sl`).
 */
export const WINDOWS_SIDE_FSTYPES_WITH_MSDOS: ReadonlySet<string> = new Set(
  'drvfs 9p virtiofs cifs smb3 smbfs nfs nfs4 ntfs ntfs3 fuseblk vfat exfat msdos'.split(
    ' ',
  ),
)

/**
 * Official native set `hm` (v299 @220000886) — filesystems that are NOT
 * Windows-side. The production `Rws` classifier treats any fstype missing
 * from this set as Windows-side; the `Cf` scan does not use it.
 */
export const NATIVE_LINUX_FSTYPES: ReadonlySet<string> = new Set(
  [
    'ext2 ext3 ext4 xfs btrfs zfs f2fs jfs reiserfs nilfs2 bcachefs tmpfs ramfs rootfs squashfs erofs',
    'proc sysfs devtmpfs devpts mqueue hugetlbfs cgroup cgroup2 pstore bpf debugfs tracefs securityfs',
    'configfs fusectl binfmt_misc nsfs rpc_pipefs efivarfs selinuxfs nfsd',
  ].flatMap((line) => line.split(' ')),
)

// Official source/options regexes (byte-exact, v299 @220000886 & @254393924).
/** Drive-letter source, e.g. `C:\` (WSL drvfs lines). */
const DRIVE_LETTER_SOURCE = /^[A-Za-z]:/
/** UNC source, e.g. `\\wsl.localhost\...` or `//host/share`. */
const UNC_SOURCE = /^(\\\\|\/\/)/
/** Remote `host:/path` source, e.g. NFS. */
const REMOTE_SOURCE = /^[^/\s]+:\//
/** 9p mount options carrying `aname=drvfs` (Windows drive served over 9p). */
const DRVFS_ANAME_OPTION = /(^|,)aname=drvfs/

/**
 * Official `B5e`: /proc/mounts octal-unescape (\040 → space, \011 → tab,
 * \134 → backslash, ...).
 */
export function octalUnescapeMountPath(value: string): string {
  return value.replace(
    /\\([0-7]{3})/g,
    (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)),
  )
}

/** Official `nt(t,".")` semantics: substring before the first delimiter. */
function fstypeBeforeDot(fstype: string): string {
  const index = fstype.indexOf('.')
  return index === -1 ? fstype : fstype.slice(0, index)
}

/** Official `qIt`: path === root, or path strictly under root (root-safe). */
export function isPathAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

/** One /proc/mounts line, split the way the official `Cf` splits it. */
export interface ProcMountsFields {
  readonly source: string
  readonly mountPoint: string
  readonly fstype: string
  readonly options: string
}

/** The official `Cf` classification predicate for one mount entry. */
export function isWindowsSideMountFields(fields: ProcMountsFields): boolean {
  const fstypeHead = fstypeBeforeDot(fields.fstype)
  return (
    WINDOWS_SIDE_MOUNT_FSTYPES.has(fields.fstype) ||
    WINDOWS_SIDE_MOUNT_FSTYPES.has(fstypeHead) ||
    fstypeHead === 'fuse' ||
    DRIVE_LETTER_SOURCE.test(fields.source) ||
    UNC_SOURCE.test(fields.source) ||
    REMOTE_SOURCE.test(fields.source) ||
    DRVFS_ANAME_OPTION.test(fields.options)
  )
}

/**
 * Official `Cf`: scan /proc/mounts text and return the deduped,
 * octal-unescaped mount points of every Windows-side mount. Lines without an
 * absolute mount point are skipped (matching the official guard).
 */
export function parseWindowsSideMountPoints(mountsText: string): string[] {
  const mountPoints: string[] = []
  for (const line of mountsText.split('\n')) {
    const [source, mountPoint, fstype, options] = line.split(' ')
    if (
      mountPoint === undefined ||
      fstype === undefined ||
      !isPosixAbsolute(mountPoint)
    ) {
      continue
    }
    if (
      isWindowsSideMountFields({
        source: source ?? '',
        mountPoint,
        fstype,
        options: options ?? '',
      })
    ) {
      mountPoints.push(octalUnescapeMountPath(mountPoint))
    }
  }
  // Official `D(n)` = [...new Set(n)].
  return [...new Set(mountPoints)]
}

// Official refusal reasons (byte-exact, v299 @254393924).
export const WSL_REFUSAL_REASON_MOUNT_TABLE_UNREADABLE =
  'the WSL mount table (/proc/mounts) cannot be read'
export const WSL_REFUSAL_REASON_NO_WINDOWS_MOUNT =
  'no Windows filesystem mount was recognized in the WSL mount table'

/**
 * Official refusal message builder (byte-exact template, v299 @254393924):
 * "A shell tool was granted, but ${reason}, so the Windows side could not be
 * put out of the sandboxed shell's reach \u2014 the run was refused."
 */
export function wslWindowsSideMountsRefusalMessage(reason: string): string {
  return `A shell tool was granted, but ${reason}, so the Windows side could not be put out of the sandboxed shell's reach \u2014 the run was refused.`
}

/**
 * Fail-closed error thrown when the Windows side cannot be put out of the
 * sandboxed shell's reach. The official error carries the tag
 * "eval: WSL Windows-side mounts undetermined" (eval-harness context); OCC
 * keeps the message byte-exact and exposes the reason instead.
 */
export class WslWindowsSideMountsUndeterminedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(wslWindowsSideMountsRefusalMessage(reason))
    this.name = 'WslWindowsSideMountsUndeterminedError'
    this.reason = reason
  }
}

/** Injectable /proc/mounts reader (tests pass fixture mount tables). */
export type WslMountTableReader = () => string

const defaultMountTableReader: WslMountTableReader = () =>
  readFileSync('/proc/mounts', 'utf8')

/**
 * Official `Of` (synchronous read — OCC builds sandbox config synchronously):
 * read the WSL mount table and return the Windows-side mount points, or throw
 * the official fail-closed refusal when the table cannot be read or no
 * Windows filesystem mount is recognized.
 */
export function getWindowsSideMountPoints(
  readMountTable: WslMountTableReader = defaultMountTableReader,
): string[] {
  let mountsText: string
  try {
    mountsText = readMountTable()
  } catch {
    throw new WslWindowsSideMountsUndeterminedError(
      WSL_REFUSAL_REASON_MOUNT_TABLE_UNREADABLE,
    )
  }
  const mountPoints = parseWindowsSideMountPoints(mountsText)
  if (mountPoints.length === 0) {
    throw new WslWindowsSideMountsUndeterminedError(
      WSL_REFUSAL_REASON_NO_WINDOWS_MOUNT,
    )
  }
  return mountPoints
}
