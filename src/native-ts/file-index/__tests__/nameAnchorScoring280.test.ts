import { describe, expect, test } from 'bun:test'

import { FileIndex } from '../index.js'

/**
 * CC 2.1.280 (changelog #074): "Improved `@` file suggestions: a file whose
 * name contains the query now ranks above one that only matches across its
 * folder names."
 *
 * Byte evidence — official v280 linux-x64 ELF, scorer class `aIt`
 * @191071715-191076100 (extracted via win.py). v278 `class $kt`
 * @192452000-192455400 has NONE of nameStarts / nameCharBits /
 * nameMatchPositions / Zc / scanFrom (win.py: 0 hits for each identifier).
 *
 *   constants (@191071715, identical in v278 @192452xxx and in OCC):
 *     Hs=16,Fs=8,Xc=6,Bs=4,$s=8,Ws=3,Gs=1,qc=100,Mn=64,iIt=4
 *
 *   fields:
 *     nameStarts=new Uint16Array(0);nameCharBits=new Int32Array(0);
 *     matchPositions=new Int32Array(Mn);nameMatchPositions=new Int32Array(Mn)
 *
 *   indexPath (basename offset + basename char bitmask, unicode-length guard):
 *     if(g>=97&&g<=122)r|=1<<g-97,c|=1<<g-97;
 *     else if((g===47||g===92)&&d<s-1)i=d+1,c=0
 *     this.nameStarts[e]=s===this.paths[e].length?i:0
 *
 *   search re-anchor branch:
 *     let ie=w[T],ge=K>0&&F[0]<ie&&(I[T]&d)===d?Zc(M,c,ie,B):-1/0;
 *     if(m.length===n&&g+Math.max(Z-K,ge)<=h)continue;
 *     ce=Z-K+js(j,F,i),me=0;
 *     if(ge!==-1/0){let ne=ge+js(j,B,i);if(ne>=ce)ce=ne,me=ie}
 *     ce+=i*Hs+Math.max(0,32-(de>>2))
 *     m.push({pathIndex:T,fuzzScore:ce,scanFrom:me})
 *
 *   highlight extraction starts at the winning anchor:
 *     te=Array(i),ie=m[T].scanFrom;
 *     for(let de=0;de<i;de++){let ce=Z.indexOf(c[de],ie);te[de]=ce,ie=ce+1}
 *
 *   Zc — greedy in-basename match (returns net bonus/penalty, -1/0 on miss):
 *     function Zc(e,n,s,r){let i=0,c=s-1;for(let d=0;d<n.length;d++){
 *       let g=e.indexOf(n[d],c+1);if(g===-1)return-1/0;r[d]=g;
 *       let m=g-c-1;if(d>0)i+=m===0?Bs:-(Ws+m*Gs);c=g}return i}
 */

function makeIndex(paths: string[]): FileIndex {
  const index = new FileIndex()
  index.loadFromFileList(paths)
  return index
}

describe('2.1.280 #074 — name-anchored ranking', () => {
  test('basename match ranks above a match spread across folder names', () => {
    // Arrange
    const index = makeIndex(['src/utils/config.ts', 'config.md'])

    // Act
    const results = index.search('config', 10)

    // Assert — fuzz 154 (config.md, first-char + consecutive run) beats
    // 152 (src/utils/config.ts, re-anchored inside the basename: name net
    // 20 + boundary bonus 8 wins over the scattered full-path net 5).
    expect(results.map(r => r.path)).toEqual([
      'config.md',
      'src/utils/config.ts',
    ])
    expect(results.map(r => r.score)).toEqual([0, 0.5])
  })

  test('name anchor lifts a folder-scattered match above a mid-word name match (v278→v280 flip)', () => {
    // Arrange — 'cnf/o-x/conf.ts' matches 'conf' greedily as c@0,o@4,n@10,f@11
    // (gap penalty 14); v280 re-anchors on the contiguous basename 'conf.ts'
    // (net 12 + boundary bonus 8 → fuzz 113). 'aconf.md' matches c@1..f@4 with
    // no gap but no boundary bonus (fuzz 106). v278 scored them 99 vs 106 —
    // the folder-scattered file LOST; v280 flips the order.
    const index = makeIndex(['cnf/o-x/conf.ts', 'aconf.md'])

    // Act
    const results = index.search('conf', 10)

    // Assert
    expect(results.map(r => r.path)).toEqual([
      'cnf/o-x/conf.ts',
      'aconf.md',
    ])
    expect(results.map(r => r.score)).toEqual([0, 0.5])
  })

  test('gap-bound reject uses Math.max of both anchoring nets', () => {
    // Arrange — path 0 fills the limit-1 topK with fuzz 90 (threshold 90).
    // Path 1's full-path net is -46 → ceiling bound 136 + (-46) = 90 ≤ 90
    // would reject it WITHOUT the official Math.max; its name net +12 gives
    // 136 + 12 = 148 > 90, survives, and its final fuzz 102 wins the slot.
    const filler = 'x'.repeat(15)
    const scattered = `c${filler}o${filler}n${filler}f/conf.ts`
    const index = makeIndex(['coxxxxxxxxxxxxxxnf.md', scattered])

    // Act
    const results = index.search('conf', 1)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe(scattered)
    expect(results[0]!.score).toBe(0)
  })

  test('no re-anchor when the full-path match has no gap penalty', () => {
    // Arrange — 'utils/x.ts' matches 'utils' contiguously at offset 0 (K=0),
    // so the re-anchor gate (K>0) never fires.
    const index = makeIndex(['utils/x.ts'])

    // Act
    const results = index.search('utils', 10)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]!.positions).toEqual([0, 1, 2, 3, 4])
  })
})

describe('2.1.280 #074 — highlight positions for both anchoring modes', () => {
  test('name-anchored mode: positions point into the basename (scanFrom = nameStart)', () => {
    // Arrange
    const index = makeIndex(['src/utils/config.ts', 'config.md'])

    // Act
    const results = index.search('config', 10)

    // Assert — full-path mode (scanFrom 0) for config.md; name-anchored mode
    // (scanFrom 10) for src/utils/config.ts: the folder 'c'@2 that the
    // full-path greedy match used is NOT highlighted.
    expect(results[0]!.positions).toEqual([0, 1, 2, 3, 4, 5])
    expect(results[1]!.positions).toEqual([10, 11, 12, 13, 14, 15])
  })

  test('full-path mode: positions kept when the basename bitmask misses a needle char', () => {
    // Arrange — 'xd/ab.ts' matches 'xb' as x@0, b@4 with a gap, but the
    // basename 'ab.ts' has no 'x' → (nameCharBits & needleBitmap) precheck
    // blocks Zc → scanFrom stays 0.
    const index = makeIndex(['xd/ab.ts'])

    // Act
    const results = index.search('xb', 10)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]!.positions).toEqual([0, 4])
  })

  test('full-path mode: positions kept when the in-basename greedy match fails (Zc → -Infinity)', () => {
    // Arrange — basename 'ed.ts' contains both 'd' and 'e' (precheck passes),
    // but 'd' then 'e' cannot be matched IN ORDER inside the basename: Zc
    // finds d@4, then no 'e' after it → -Infinity → full-path score and
    // scanFrom 0 are kept.
    const index = makeIndex(['xd/ed.ts'])

    // Act
    const results = index.search('de', 10)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]!.positions).toEqual([1, 3])
  })

  test('name anchoring handles Windows backslash separators', () => {
    // Arrange — indexPath treats charCode 92 like 47: nameStart lands after
    // the last '\'.
    const index = makeIndex(['src\\utils\\config.ts'])

    // Act
    const results = index.search('config', 10)

    // Assert
    expect(results).toHaveLength(1)
    expect(results[0]!.positions).toEqual([10, 11, 12, 13, 14, 15])
  })

  test('case-sensitive query extracts positions from the original-case path', () => {
    // Arrange — uppercase in the query enables smart-case; 'config.md' has
    // no 'C' and drops out entirely.
    const index = makeIndex(['src/Config.ts', 'config.md'])

    // Act
    const results = index.search('Config', 10)

    // Assert
    expect(results.map(r => r.path)).toEqual(['src/Config.ts'])
    expect(results[0]!.positions).toEqual([4, 5, 6, 7, 8, 9])
  })

  test('empty query returns top-level entries with empty positions', () => {
    // Arrange
    const index = makeIndex(['src/a.ts', 'b.md'])

    // Act
    const results = index.search('', 10)

    // Assert — official v278+ topLevelCache entries carry positions:[].
    expect(results).toEqual([
      { path: 'src', score: 0, positions: [] },
      { path: 'b.md', score: 0, positions: [] },
    ])
  })
})
