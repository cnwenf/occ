import { describe, expect, test } from 'bun:test'
import { checkWorktreeGitRedirect } from '../worktreeGitRedirectGuard.js'

/**
 * CC 2.1.216 #8: worktree-isolated subagents must not redirect git into the
 * shared/parent checkout (isolation escape) via `git -C` / `--git-dir` /
 * `--work-tree` / `GIT_DIR` / `GIT_WORK_TREE` / `--bare`.
 *
 * Reverse-engineered from the 2.1.216/2.1.217 ELF per `aligning-with-official-
 * binary`. OCC did not have this guard — a real divergence, now ported.
 */

const WORKTREE = '/tmp/wt'
const CWD = '/tmp/wt'
const SHARED = '/tmp/main'

describe('CC 2.1.216 #8 — worktree git-redirect guard', () => {
  describe('blocks redirects to the shared checkout (outside the worktree)', () => {
    test('git -C <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(`git -C ${SHARED} status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.mechanism).toBe('-C')
      expect(b!.reason).toContain('shared checkout')
      expect(b!.reason).toContain('cannot verify')
    })

    test('git --git-dir <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --git-dir ${SHARED}/.git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--git-dir')
    })

    test('git --git-dir=<shared> (equals form) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --git-dir=${SHARED}/.git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--git-dir')
    })

    test('git --work-tree <shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git --work-tree ${SHARED} status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('--work-tree')
    })

    test('GIT_DIR=<shared> env-prefix -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('GIT_WORK_TREE=<shared> env-prefix -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_WORK_TREE=${SHARED} git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_WORK_TREE')
    })

    test('redirect on the 2nd arm of an && list -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git -C ${WORKTREE} status && git -C ${SHARED} log`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('-C')
      expect(b!.reason).toContain('shared checkout')
    })
  })

  describe('blocks unverifiable targets', () => {
    test('glob target -> glob reason', () => {
      const b = checkWorktreeGitRedirect(
        `git -C ${SHARED}/* status`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('glob pattern that expands at runtime')
      expect(b!.reason).toContain('spell out the literal path')
    })

    test('dynamic target ($VAR) -> computed-at-runtime reason', () => {
      const b = checkWorktreeGitRedirect(`git -C $HOME status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('computed at runtime')
    })

    test('tilde target -> computed-at-runtime reason', () => {
      const b = checkWorktreeGitRedirect(`git -C ~/repo status`, WORKTREE, CWD)
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('computed at runtime')
    })

    test('--bare -> unverifiable (no worktree to bound against)', () => {
      const b = checkWorktreeGitRedirect(`git --bare`, WORKTREE, CWD)
      expect(b!.mechanism).toBe('--bare')
      expect(b!.reason).toContain('cannot verify')
    })
  })

  describe('allows safe commands', () => {
    test('git -C <worktree-subdir> -> ok (inside the worktree)', () => {
      expect(
        checkWorktreeGitRedirect(`git -C ${WORKTREE}/sub status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('git -C <worktree itself> -> ok', () => {
      expect(
        checkWorktreeGitRedirect(`git -C ${WORKTREE} status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('plain git status (no redirect) -> ok', () => {
      expect(checkWorktreeGitRedirect('git status', WORKTREE, CWD)).toBeNull()
    })

    test('relative target inside worktree -> ok', () => {
      // cwd is the worktree; a relative subdir resolves inside it.
      expect(
        checkWorktreeGitRedirect('git -C ./sub status', WORKTREE, CWD),
      ).toBeNull()
    })

    test('non-git command -> ok (not guarded)', () => {
      expect(checkWorktreeGitRedirect(`ls ${SHARED}`, WORKTREE, CWD)).toBeNull()
    })

    test('non-git -C (e.g. grep -C) -> ok (not a git redirect)', () => {
      expect(
        checkWorktreeGitRedirect(`grep -C 2 pattern ${SHARED}`, WORKTREE, CWD),
      ).toBeNull()
    })
  })

  // Security review point 3 (blocking): the previous leading-prefix-only scan
  // was bypassed by `env`/`sudo`/`command` wrappers (`rest[0]='env'` ≠ git →
  // whole span skipped). The fix scans KEY=VAL env-assignments ANYWHERE in the
  // span + finds `git` ANYWHERE. 17 prior tests had zero `env` hits — these
  // close that gap.
  describe('env/wrapper bypass (point 3) — KEY=VAL anywhere + git anywhere', () => {
    test('env GIT_DIR=<shared> git -> block', () => {
      const b = checkWorktreeGitRedirect(
        `env GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
      expect(b!.reason).toContain('shared checkout')
    })

    test('env GIT_WORK_TREE=<shared> git -> block', () => {
      const b = checkWorktreeGitRedirect(
        `env GIT_WORK_TREE=${SHARED} git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_WORK_TREE')
    })

    test('env -i GIT_DIR=<shared> git (env own flag) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `env -i GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('env GIT_DIR=<shared> /usr/bin/git (absolute git) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `env GIT_DIR=${SHARED}/.git /usr/bin/git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('env GIT_DIR=<shared> git --git-dir /x (env + flag) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `env GIT_DIR=${SHARED}/.git git --git-dir /x status`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('cannot verify')
    })

    test('sudo GIT_DIR=<shared> git (sudo wrapper) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `sudo GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('plain GIT_DIR=<shared> git (no wrapper) still -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_DIR=${SHARED}/.git git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_DIR')
    })

    test('env GIT_DIR=<worktree> git (inside worktree) -> ok', () => {
      expect(
        checkWorktreeGitRedirect(
          `env GIT_DIR=${WORKTREE}/.git git status`,
          WORKTREE,
          CWD,
        ),
      ).toBeNull()
    })

    test('env FOO=bar git (non-redirect env) -> ok', () => {
      expect(
        checkWorktreeGitRedirect(`env FOO=bar git status`, WORKTREE, CWD),
      ).toBeNull()
    })
  })

  // Expanded mechanisms (official `Xss` env set + `lzg` `-c` config keys) —
  // reverse-engineered from the 2.1.217 ELF. OCC was missing these (only had
  // GIT_DIR/GIT_WORK_TREE); now matches the official's full set.
  describe('expanded mechanisms (official Xss + lzg -c config)', () => {
    test('GIT_COMMON_DIR=<shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_COMMON_DIR=${SHARED}/.git/common git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_COMMON_DIR')
    })

    test('GIT_OBJECT_DIRECTORY=<shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_OBJECT_DIRECTORY=${SHARED}/objects git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_OBJECT_DIRECTORY')
    })

    test('GIT_INDEX_FILE=<shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_INDEX_FILE=${SHARED}/index git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_INDEX_FILE')
    })

    test('GIT_SHALLOW_FILE=<shared> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `GIT_SHALLOW_FILE=${SHARED}/shallow git status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('GIT_SHALLOW_FILE')
    })

    test('git -c core.worktree=<shared> (lzg config redirect) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git -c core.worktree=${SHARED} status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('-c')
      expect(b!.reason).toContain('cannot verify')
    })

    test('git -c core.bare=true (lzg) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git -c core.bare=true status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('-c')
    })

    test('git -c include.path=../x (lzg include.*) -> block', () => {
      const b = checkWorktreeGitRedirect(
        `git -c include.path=../evil status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('-c')
    })

    test('git -c user.name=foo (non-redirect config) -> ok', () => {
      expect(
        checkWorktreeGitRedirect(`git -c user.name=foo status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('git --namespace=foo (q6g arg-skip, NOT a redirect) -> ok', () => {
      // Official `q6g` flags (--namespace/--attr-source/--shallow-file) take
      // an arg but are NOT redirect mechanisms — the walker just skips them.
      expect(
        checkWorktreeGitRedirect(`git --namespace=foo status`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('git --attr-source=HEAD log (q6g) -> ok', () => {
      expect(
        checkWorktreeGitRedirect(`git --attr-source=HEAD log`, WORKTREE, CWD),
      ).toBeNull()
    })
  })

  // Follow-up A (ozg shell-wrapper obfuscation): a worktree subagent must not
  // run git through an unverifiable wrapper — a builtin that runs a string
  // (eval/source/./…), xargs/parallel feeding git from stdin, or
  // find -execdir/-okdir cd-ing per match. Reverse-engineered from the
  // 2.1.217 ELF `ozg`/`NZt`/`tzg`/`nzg`. Note: `bash -c`/`sh -c` are NOT in
  // the official's `rLu` (builtins only), so ozg does NOT catch them —
  // matching the official, not inventing.
  describe('ozg shell-wrapper obfuscation (Follow-up A)', () => {
    test('eval "git …" -> block (builtin string-exec)', () => {
      const b = checkWorktreeGitRedirect(
        `eval "git -C ${SHARED} status"`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('eval')
      expect(b!.reason).toContain("runs a string through eval")
    })

    test('source <script> -> block', () => {
      const b = checkWorktreeGitRedirect(
        `source ${SHARED}/x.sh`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('source')
    })

    test('. <script> (pos 0) -> block', () => {
      const b = checkWorktreeGitRedirect(`. ${SHARED}/x.sh`, WORKTREE, CWD)
      expect(b!.mechanism).toBe('.')
    })

    test('eval "echo hi" (no git) -> block (branch 3 ungated, matches official)', () => {
      // ozg's builtin-string-exec branch is NOT git-gated — worktree
      // isolation forbids unverifiable string-exec, per the official.
      const b = checkWorktreeGitRedirect(`eval "echo hi"`, WORKTREE, CWD)
      expect(b!.mechanism).toBe('eval')
    })

    test('xargs git -> block (feeds git from stdin)', () => {
      const b = checkWorktreeGitRedirect(
        `xargs git -C ${SHARED}`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('xargs/parallel')
      expect(b!.reason).toContain('stdin at runtime')
    })

    test('parallel git -> block', () => {
      const b = checkWorktreeGitRedirect(
        `parallel git -C ${SHARED} :::`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('xargs/parallel')
    })

    test('find -execdir git -> block (cd per match)', () => {
      const b = checkWorktreeGitRedirect(
        `find . -execdir git status \\;`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('find -execdir/-okdir')
      expect(b!.reason).toContain('changes directory per match')
    })

    test('find -okdir git -> block', () => {
      const b = checkWorktreeGitRedirect(
        `find . -okdir git status \\;`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('find -execdir/-okdir')
    })

    test('eval; git -C <shared> -> block (rLu builtin before a later git)', () => {
      const b = checkWorktreeGitRedirect(
        `eval; git -C ${SHARED} status`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('eval')
      expect(b!.reason).toContain('before a git command')
    })

    test('bash -c "git …" -> block (Follow-up A supplement: shell -c escape)', () => {
      // OCC doesn't recursively parse -c strings, so `bash -c 'git -C /shared
      // …'` is a direct worktree escape (equivalent to `eval "git …"`) — block
      // at the ozg layer (beyond the official ozg's rLu builtins, by explicit
      // leader sign-off). Confirms the escape-PATH block, not a coincidental
      // KEY=VAL hit: the redirect is inside the quoted -c string.
      const b = checkWorktreeGitRedirect(
        `bash -c "git -C ${SHARED} status"`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.mechanism).toBe('bash -c')
      expect(b!.reason).toContain('runs a string through bash -c')
      // No GIT_DIR= env-assignment here → proves it's the shell -c path, not
      // the anywhere-KEY=VAL scan that blocked it.
      expect(b!.reason).not.toContain('GIT_DIR')
    })

    test('sh -c "git …" -> block (Follow-up A supplement)', () => {
      const b = checkWorktreeGitRedirect(
        `sh -c "git -C ${SHARED} status"`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.mechanism).toBe('sh -c')
    })

    test('bash -c single-quoted git redirect -> block', () => {
      const b = checkWorktreeGitRedirect(
        `bash -c 'git -C ${SHARED} status'`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('bash -c')
    })

    test('sh -c single-quoted git redirect -> block', () => {
      const b = checkWorktreeGitRedirect(
        `sh -c 'git -C ${SHARED} status'`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('sh -c')
    })

    test('zsh -c "git …" -> block (portable shell)', () => {
      const b = checkWorktreeGitRedirect(
        `zsh -c "git -C ${SHARED} status"`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('zsh -c')
    })

    test('dash -c "git …" -> block', () => {
      const b = checkWorktreeGitRedirect(
        `dash -c "git -C ${SHARED} status"`,
        WORKTREE,
        CWD,
      )
      expect(b!.mechanism).toBe('dash -c')
    })

    test('bash script.sh (scriptfile) -> block (same class as source)', () => {
      const b = checkWorktreeGitRedirect(
        `bash ${SHARED}/evil.sh`,
        WORKTREE,
        CWD,
      )
      expect(b).not.toBeNull()
      expect(b!.reason).toContain('runs a string through bash -c')
    })

    test('bash with no -c and no scriptfile (REPL) -> ok', () => {
      // `bash` alone / `bash -l` (login) starts a REPL — no string/script
      // payload → not the -c escape vector.
      expect(
        checkWorktreeGitRedirect(`bash -l`, WORKTREE, CWD),
      ).toBeNull()
    })

    test('plain echo (no wrapper) -> ok', () => {
      expect(checkWorktreeGitRedirect('echo hi', WORKTREE, CWD)).toBeNull()
    })
  })
})
