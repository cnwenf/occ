import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { REPO_ROOT } from './helpers'

const VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version: string
  }
).version

function freshHome(root: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      numStartups: 1,
      firstStartTime: '2026-07-24T00:00:00.000Z',
      migrationVersion: 11,
      userID:
        'occ-resume-e2e-0000000000000000000000000000000000000000000001',
      hasCompletedOnboarding: true,
      lastOnboardingVersion: VERSION,
      lastReleaseNotesSeen: VERSION,
      projects: { [REPO_ROOT]: { hasTrustDialogAccepted: true } },
    }),
  )
  writeFileSync(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({ disableAllHooks: true }),
  )
  return home
}

function runInteractiveOcc(
  args: string[],
  home: string,
  binDir: string,
  beforeExit?: string,
): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const command = ['occ', ...args].join(' ')
    const child = spawn('script', ['-qfec', command, '/dev/null'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        TERM: 'xterm-256color',
        ANTHROPIC_AUTH_TOKEN: 'occ-resume-e2e-no-model-call',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_UNATTENDED_RETRY: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let output = ''
    let beforeExitSent = false
    let exitSent = false
    let settled = false

    const sendExit = () => {
      if (exitSent) return
      exitSent = true
      child.stdin.write('/exit\r')
    }
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString()
      if (
        output.toLowerCase().includes('shift+tab') ||
        output.toLowerCase().includes('open c code')
      ) {
        if (beforeExit && !beforeExitSent) {
          beforeExitSent = true
          child.stdin.write(`${beforeExit}\r`)
        } else if (!beforeExit) {
          sendExit()
        }
      }
      if (beforeExitSent && output.includes(beforeExit!)) {
        setTimeout(sendExit, 500)
      }
    }

    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const fallback = setTimeout(sendExit, 5_000)
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(fallback)
      clearTimeout(timeout)
      resolve({ code: code ?? -1, output })
    })
  })
}

describe.skipIf(!!process.env.CI)(
  'OCC interactive resume command (PTY e2e)',
  () => {
    test(
      'exit prints occ --resume and that command restores the session',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'occ-resume-command-'))
        const binDir = join(root, 'bin')
        mkdirSync(binDir)
        const occPath = join(binDir, 'occ')
        symlinkSync(join(REPO_ROOT, 'bin', 'occ.cjs'), occPath)
        chmodSync(occPath, 0o755)
        const home = freshHome(root)

        try {
          const first = await runInteractiveOcc(
            [],
            home,
            binDir,
            '! printf occ-resume-e2e',
          )
          expect(first.code).toBe(0)
          expect(first.output).toContain('Resume this session with:')
          const match = first.output.match(
            /Resume this session with:\s*occ --resume ([0-9a-f-]{36})/i,
          )
          expect(match).not.toBeNull()
          expect(first.output).not.toContain('claude --resume')

          const sessionId = match?.[1]
          expect(sessionId).toBeTruthy()
          const resumed = await runInteractiveOcc(
            ['--resume', sessionId!],
            home,
            binDir,
          )
          expect(resumed.code).toBe(0)
          expect(resumed.output).not.toContain('No conversation found')
          expect(resumed.output).not.toContain('claude --resume')
          expect(resumed.output).toContain(`occ --resume ${sessionId}`)
        } finally {
          rmSync(root, { recursive: true, force: true })
        }
      },
      45_000,
    )
  },
)
