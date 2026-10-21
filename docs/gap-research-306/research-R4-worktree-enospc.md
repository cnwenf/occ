Research complete — both items fully evidenced. Final deliverable:

---

# Item 1 — Worktree: bare-repo base-ref + subagent worktree cleanup (2.1.305)

**Verdict: NO GAP** (optional byte-parity micro-hardening noted at end)

## Byte evidence

**The actual 305 fix = base-ref resolution, not cleanup code.**

- **v304 create path** (`/tmp/cc-diff-306/v304/package/claude`, dump @248983600) — passes the ref **NAME** as `git worktree add` start-point:
```js
if(rt===0)H=Ge; else t(`[worktree] fetch of origin/${$e} failed — basing worktree on local HEAD`,…),
  K=await YEn({…,kind:"head_fallback"}),H=`${K}^{commit}`
if(!K)K=await uRn({base:H,kind:H==="FETCH_HEAD"?"fetch_head":"origin_default",…});
J.push("--no-track",r?.isBranchNew?"-b":"-B",h,s,H);   // ← base = symbolic ref name (THE BUG)
```
In a bare repo, `git worktree add … origin/main` DWIM-resolves ambiguously and can start from local HEAD.

- **v306 create path** (dump @250458800) — resolves the **exact ref** and passes the **peeled SHA**:
```js
if(it===0)H=Ye,q=await yot({base:`refs/remotes/${Ye}`,exactRef:!0,kind:"origin_default",
  failure:`Failed to resolve base branch "${Ye}"`,cwd:e,root:e});
…
let Se=`${q}^{commit}`;
Q.push("--no-track",r?.isBranchNew?"-b":"-B",h,s,Se);   // ← base = PEELED SHA
```

- **The genuinely-new resolver** (`exactRef`: s304 count **0** → s305 **3**):
```js
// v304: uRn({base,kind,failure,cwd,root}) → git rev-parse --verify --quiet <base>
// v305/306: yot({base,kind,failure,cwd,root,exactRef}) →
w=y===!0?"show-ref":"rev-parse",
… y===!0?[...Tn,"show-ref","--verify","--hash",e]:[...Tn,"rev-parse","--verify","--quiet",e]
```
(`show-ref","--verify","--hash"` s304:1 → s305:2 — the +1 is this resolver.)

- **Cleanup path proved UNCHANGED 304→305** (identical s304/s305/s306 counts; `new305.txt` appearances are minifier var-churn only — e.g. the `main-worktree/HEAD` + `config --bool --get core.bare` helper is byte-identical modulo `sm→Up`, `Lt→$t`, `An→Tn`, `fc→hc`): `worktreeCleanlyRemoved` 3/3/3 · `spawnedWithWorktree` 3/3/3 · `resetToFreshBase` 3/3/3 · `inheritedWorktreePath` 3/3/3 · `primaryCheckoutVouches` 5/5 · `countCommitsAtStake` 2/2 · `keepsWorktreesInside` 3/3/3 · `worktree","remove","--force"` 4/4 · `outcome==="unanchored"` 4/4 · `basing worktree on local HEAD` 1/1.

⇒ Both changelog symptoms share **one root cause**: when the worktree starts from the wrong base (local HEAD in a bare repo), the "unchanged" determination (commits-at-stake vs. base) mismatches and cleanup is skipped. No separate cleanup-logic change exists in 305.

## OCC current state

- `src/utils/worktree.ts:375-385` — origin SHA via **direct exact ref-file read** (`resolveRef(gitDir, 'refs/remotes/origin/<default>')`) — inherently exact-ref, immune to DWIM ambiguity.
- `src/utils/worktree.ts:466-484` — argv pushes `${baseSha}^{commit}` (peeled SHA), ported from Official 2.1.300 #29. **Already matches v306's anti-local-HEAD mechanism.**
- `src/utils/worktree.ts:387-420` — fetch-failure path with byte-exact warn `[worktree] fetch of origin/<b> failed — basing worktree on local HEAD` (em-dash) + `rev-parse --verify --quiet HEAD`.
- Cleanup machinery (`cleanupStaleAgentWorktrees` :1298, `countCommitsAtStake` :2010, HEAD classification :1859-1976) mirrors the unchanged official code.

Pre-existing divergences from BOTH 304 and 306 (not 305 deltas, do not touch in this round): no `--no-track`, no `isBranchNew` `-b`/`-B` conditional, no FETCH_HEAD staleness refresh.

**Optional hardening (skip unless byte-parity desired):** swap the raw ref-file read for `git show-ref --verify --hash refs/remotes/origin/<default>` to mirror the `exactRef` resolver exactly.

---

# Item 2 — Bash ENOSPC pre-execution guard (2.1.305)

**Verdict: PORT**

## Byte evidence

**Novelty** (all s304:**0**): `"The command was not started"` s305:2 s306:2 · `"file that captures command output"` s305:2 · `"this computer's disk is full"` s305:2 s306:2 new305:2.

**Code site** (v306, string pool @126106565, code @249973940 / dump @249971200) — bash spawn catch block, verbatim:
```js
}catch(cs){
  if(Fa!==void 0&&Er)Er=!1,KSn(Fa);
  if(ps!==void 0)Ve.unregisterCommandNetworkLists(ps);
  if(await itt(ji,Ga),sr.clear(),t(`Shell exec error: ${d(cs)}`),G9o(cs)){ /* E2BIG */ return t(Fr,{level:"error"}),Ok(Fr,"e2big")}
  if(Fa===void 0&&FSn(cs))return Ok(`The command was not started: this computer's disk is full (${E(cs)}), so the file that captures command output could not be created. Nothing ran. If this is the user's own computer, tell them before deleting anything to make room.`);
  return Ok(d(cs))
}
```
- `Fa` = spawned child (`undefined` ⇒ spawn never happened), `Ok(...)` = tool error result, `d(cs)` = error stringifier, `t(...)` = debug log.
- **`FSn` definition** (@237500817, verbatim): `function FSn(n){let e=E(n);return e==="ENOSPC"||e==="EDQUOT"}` — sits in the shared errno-predicate cluster (`G`=ENOENT, `Ti`=ENOENT/ENOTDIR, `pV`=EISDIR, `G9o`=E2BIG). `${E(cs)}` interpolates the errno code, e.g. `(ENOSPC)`.
- Official opens the output-capture file **pre-spawn** (fd `ji` passed to stdio, closed via `itt(ji,Ga)` in the catch); open failure ⇒ `Fa===void 0` ⇒ friendly message.
- The 304 **during-execution** family ("Command output was lost: the temp filesystem … is full", pool @126194211) has identical 304↔305 counts — NOT this item; OCC already ports that family.

## OCC current state — the raw-ENOSPC bug exists 1:1

OCC uses the **same file-fd architecture** (`stdio[1]/[2] = outputHandle.fd`, "no JS involvement" — `src/utils/ShellCommand.ts:118-121`):

- `src/utils/Shell.ts:333-360` — `await mkdir(getTaskOutputDir(), {recursive:true})` and
  ```ts
  outputHandle = await open(taskOutput.path, win32 ? 'w' : O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW)
  ```
  execute **OUTSIDE the `try` block** ⇒ ENOSPC there propagates as a raw `ENOSPC: no space left on device, open '<path>'` — exactly the 304 symptom the changelog fixes.
- `src/utils/Shell.ts:476-524` catch — `logForDebugging(\`Shell exec error: ${errorMessage(error)}\`)` → `isE2BIG` branch (2.1.201) → fallback `createAbortedCommand(undefined,{code:126, stderr:errorMessage(error)})`. **No ENOSPC branch.** Order already matches official (log → E2BIG → fallback), so the new branch slots between E2BIG and fallback.
- Reusable classifier already in tree: `src/utils/auth.ts:2015-2029` (official `TGo`: `code === 'ENOSPC' || code === 'EDQUOT'` + message-includes fallback); `isE2BIG`/`isENOENT` live in `src/utils/errors.ts`.
- `src/tools/BashTool/BashTool.tsx:902-903` surfaces `preSpawnError`/failed-command stderr to the model — friendly text will reach the user through the existing path.
- PowerShell shares `Shell.exec` ⇒ one fix covers both tools (`PowerShellTool.tsx:606-611` mirrors the preSpawnError handling).

## Port plan (precise)

**File 1 — `src/utils/errors.ts`** (next to `isE2BIG`/`isENOENT`):
- Add `getErrorCode(err: unknown): string | undefined` (mirrors official `E`; skip if an equivalent already exists) and
  ```ts
  export function isDiskFullError(err: unknown): boolean {
    const code = getErrorCode(err)
    if (code === 'ENOSPC' || code === 'EDQUOT') return true
    // message-substring fallback, same shape as auth.ts:2015-2029
    const msg = err instanceof Error ? err.message : ''
    return msg.includes('ENOSPC') || msg.includes('EDQUOT') || msg.includes('no space left on device')
  }
  ```

**File 2 — `src/utils/Shell.ts`**:
1. Move the `mkdir(getTaskOutputDir())` + `open(...)` block **inside** the guarded `try` (or extend the try upward), keeping `outputHandle` declared before it.
2. Track spawn state: `let childSpawned = false`; set `childSpawned = true` immediately after `spawn(...)` returns (official `Fa===void 0` semantics).
3. In the catch, **after** the `isE2BIG` branch and **before** the fallback `createAbortedCommand`, insert (byte-exact string, official @249973940):
   ```ts
   // Official 2.1.305: pre-spawn output-file creation failed on a full disk —
   // never surface the raw ENOSPC path.
   if (!childSpawned && isDiskFullError(error)) {
     return createAbortedCommand(undefined, {
       code: 126, // Standard Unix code for execution errors
       stderr: `The command was not started: this computer's disk is full (${getErrorCode(error)}), so the file that captures command output could not be created. Nothing ran. If this is the user's own computer, tell them before deleting anything to make room.`,
     })
   }
   ```
   `Ok(msg)` single-arg ↔ `createAbortedCommand({code:126, stderr})` mapping is consistent with OCC's existing port of the official fallback `Ok(d(cs))`.
4. fd hygiene unchanged: existing catch already closes `outputHandle` when defined; when `open` itself throws it stays `undefined` — the `if (outputHandle !== undefined)` guards handle it.

**Test plan:**
- *Unit (Shell.test.ts, AAA):* mock `fs/promises.open` to reject `Object.assign(new Error("ENOSPC: no space left on device, open '/x'"), {code:'ENOSPC'})` → assert (a) spawn spy never called ("Nothing ran"), (b) result stderr equals the byte-exact message with `(ENOSPC)`, (c) no raw path in stderr, (d) `Shell exec error:` debug log fired.
- EDQUOT variant → message shows `(EDQUOT)`.
- Negative: `EACCES` from open → unchanged generic code-126 `errorMessage` fallback; E2BIG branch still wins ordering when both mocked.
- Pipe-mode (`onStdout` provided) → no pre-spawn open, guard inert.
- *E2E (real REPL, per identity mandate):* in a container, `mount -t tmpfs -o size=64k` a scratch fs, fill it, point the task-output dir/`CLAUDE_CODE_TMPDIR` at it, run a Bash tool command through the REPL → model-visible result contains "The command was not started … Nothing ran." and a canary side-effect file the command would create does NOT exist.