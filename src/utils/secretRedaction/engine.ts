// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.296 minified source (verbatim port)
// biome-ignore-all lint/correctness/noEmptyCharacterClassInRegex: [^] is the intentional JS any-char class in the official fe quoted-string detector (verbatim port)
/**
 * The secret-redaction engine (upstream class En + singleton D).
 *
 * Ported verbatim from the official Claude Code 2.1.296 linux-x64 binary
 * (evidence window /tmp/cc296/ev-rules296.txt; 2.1.286-era OCC port upgraded
 * to the 295/296 shape - the 295 dump ev-rules295.txt is engine-identical).
 * Pipeline: low-confidence context rules (redactContext) + high-confidence
 * token rules (redactTokens) + PEM blocks, with URL userinfo spans AND the
 * new two-phase assign-scanner spans (assignScanner.ts, the 2.1.296
 * key-with-no-value / escaped-JSON-in-shell-string fix) applied on the
 * ORIGIN-TRACKED document so a redaction span is never cut by slicing.
 * Display path (redactForDisplay) skips shell/URL-ish values.
 *
 * 296 engine deltas vs 286:
 *   - redactContext(e,n=!1): second boolean gates redactOnly rules (via
 *     ruleApplies ≡ upstream Xe); full-redact paths (redactWithUrlRanges,
 *     redactTracked, mZn, D6r tracked branch) pass !0, fZn/mQ defaults !1.
 *   - scan/redactTokens/redactForDisplay honor per-rule prefilter.
 *   - redactOnlyRules(e): NEW method (upstream same name).
 *   - trackedByRules/trackedContext/trackedRules gain the gate parameter.
 *   - fe (upstream Re) unions the assign-scanner spans (scanAssignSpans ≡
 *     ls) and merges via mergeSpans (≡ bn).
 *   - ue/he builder: run-rule branch (anthropic-oauth-token) + prefilter
 *     propagation + redactOnly propagation; Fn/is builder: displayRun
 *     branch (11 gitlab rules) with wrapped boundary regex + prefilter.
 *   - yn strip helper (upstream same name).
 *   - M4 (≡ b9) redacts OBJECT KEYS through ys dedupeRedactedKeys when the
 *     default redactor is used; D6r (≡ zCo) gains the mQ/redactOnlyRules
 *     fallbacks; mZn (≡ QRr) pre-redacts context with gate !0 and Bn (≡ Hs)
 *     is tokens-only.
 *
 * Documented divergences (upstream helpers absent from every evidence
 * window; behavior fully constrained by the verbatim call sites):
 *   Xe - gate fn reconstructed as ruleApplies (redactOnly gate + prefilter).
 *   je - upstream's text-only scanner unioned into Re; NOT ported (OCC's dt
 *        monolith already unions family+URL spans; see task report).
 *   Hs - reconstructed as the tokens-only doubling loop (call site already
 *        context-redacts with gate !0).
 *   Bs - upstream label map; OCC keeps 286's ir (identical for all 63 shared
 *        rule ids; "sensitive-assign-escaped" labels via Su capitalize).
 *   oo/ao (exported loose-jwt RegExps) - unused by OCC's surface, omitted.
 *
 * Public entry points (OCC export names, stable):
 *   g4o - scan(text): [{ruleId,label}] without redacting
 *   Rs  - redact(text): full redaction (cached for short strings)
 *   mQ  - redactTokens(redactContext(text))
 *   fZn - redactContext (low-confidence rules + PEM; redactOnly gated OFF)
 *   fvn - redactTokens (high-confidence rules)
 *   mZn - capped redaction that doubles the window until the budget fits
 *   LSe - redactForDisplay
 *   M4  - deep object/array redactor (strings via key:value context)
 *   D6r - redact one "key: value" pair, clamped to the value
 *   OGt - redact every value whose KEY matches the credential-key regex Fe
 */

import { Su, re } from './textSlicing.js'
import { ot, at, ie, Te } from './trackedDoc.js'
import { dt } from './urlScanner.js'
import { scanAssignSpans, mergeSpans } from './assignScanner.js'
import { Fe, St, On, ir } from './rules.js'
import { Dn, H6r, Et } from './pem.js'

var pt=`(?:[\\x60'"\\s;]|\\\\[nr]|$)`,mt="(?=[^a-zA-Z0-9_\\-+=]|$)",_n="(?<![a-zA-Z0-9_\\-])";function Fn(){return St.map(({id:e,confidence:n,source:r,flags:s="",displayRun:i})=>{let o={id:e,confidence:n},a=s.replace("g","")+"g";if(n!=="high")return{...o,re:new RegExp(r,a)};let u=yn(r);if(i===void 0)return{...o,re:new RegExp(_n+u+mt,a)};return{...o,prefilter:new RegExp(u,s.replace("g","")),re:new RegExp(`(?<!${i})(?=${i}+${mt})${i}*?${_n}(${u})${mt}`,a)}})}function ue(e){return St.map((n)=>{let r=(n.flags??"").replace("g",""),s={id:n.id,confidence:n.confidence,...n.redactOnly===!0&&{redactOnly:n.redactOnly},...n.prefilter!==void 0&&{prefilter:n.prefilter}};if(n.run===void 0)return{...s,re:new RegExp(n.source,e?r+"g":n.flags??"")};return{...s,prefilter:new RegExp(yn(n.source),r),re:new RegExp(`(?:(?<!${n.run})|(?<=\\[nr]))(?=${n.run}+${pt})${n.run}*?${n.source}`,e?r+"g":r)}})}function yn(e){return e.endsWith(pt)?e.slice(0,-pt.length):e}function ruleApplies(e,n,r){return(e.redactOnly!==!0||n)&&e.prefilter?.test(r)!==!1}function _e(e,n){if(typeof n!=="string")return"[REDACTED]";let r=n.length>=2&&(n[0]==='"'||n[0]==="'")&&n.at(-1)===n[0]?n[0]:"",s=e.lastIndexOf(n);return`${e.slice(0,s)}${r}[REDACTED]${r}${e.slice(s+n.length)}`}function Cn(e){let n=e[1];if(typeof n!=="string")return{keep:0,insert:"[REDACTED]"};let r=n.length>=2&&(n[0]==='"'||n[0]==="'")&&n.at(-1)===n[0]?1:0,s=e[0].lastIndexOf(n);return{keep:s+r,insert:"[REDACTED]",keepEnd:e[0].length-s-n.length+r}}function fe(e){let n=dt(e,On).map(({start:r,end:s})=>{let i=/^(["'])[^]*\1$/.test(e.slice(r,s))?1:0;return[r+i,s-i]}),o=scanAssignSpans(e);return o.length===0?n:mergeSpans([...n,...o])}function se(e,n){let{text:r,origin:s}=e,i=[],o=0;for(let a=0;a<r.length;){let u=s[a];while(o<n.length&&n[o][1]<=u)o++;let l=n[o];if(u<0||l===void 0||u<l[0]){a++;continue}let c=a;while(c>0&&s[c-1]<0)c--;while(a<r.length&&(s[a]<0||s[a]>=l[0]&&s[a]<l[1]))a++;let f=i.at(-1);if(f!==void 0&&f[1]>=c)f[1]=a;else i.push([c,a,"[REDACTED]"])}return ie(e,i)}var Nn=512,Hn=512;class wt{testRules=null;redactRules=null;displayRules=null;resultCache=new Map;scan(e){this.testRules??=ue(!1);let n=[];for(let r of this.testRules)if(r.confidence==="high"&&r.prefilter?.test(e)!==!1&&r.re.test(e))n.push({ruleId:r.id,label:r.id.split("-").map((s)=>ir[s]??Su(s)).join(" ")});if(Dn(e))n.push({ruleId:"private-key",label:"Private Key"});return n}redactContext(e,n=!1){this.redactRules??=ue(!0);let r=H6r(e);for(let s of this.redactRules)if(s.confidence==="low"&&ruleApplies(s,n,r))r=r.replace(s.re,_e);return r}redactTokens(e){this.redactRules??=ue(!0);let n=e;for(let r of this.redactRules)if(r.confidence==="high"&&r.prefilter?.test(n)!==!1)n=n.replace(r.re,_e);return n}trackedByRules(e,n=!1){return this.trackedTokens(this.trackedContext(e,n))}trackedContext(e,n=!1){let r=ie(ot(e),Et(e).map(({start:s,end:i})=>[s,i,"[REDACTED]"]));return this.trackedRules(r,"low",n)}redactOnlyRules(e){this.redactRules??=ue(!0);let n=e;for(let r of this.redactRules)if(r.redactOnly===!0&&ruleApplies(r,!0,n))n=n.replace(r.re,_e);return n}trackedTokens(e){return this.trackedRules(e,"high")}trackedRules(e,n,r=!1){this.redactRules??=ue(!0);let s=e;for(let i of this.redactRules)if(i.confidence===n&&ruleApplies(i,r,s.text))i.re.lastIndex=0,s=at(s,i.re,Cn);return s}redactWithUrlRanges(e){let n=fe(e);return n.length===0?this.redactTokens(this.redactContext(e,!0)):se(this.trackedByRules(e,!0),n).text}redactTracked(e){return se(this.trackedByRules(e,!0),fe(e))}redact(e){let n=e.length<=Nn;if(n){let s=this.resultCache.get(e);if(s!==void 0)return s}let r=this.redactWithUrlRanges(e);if(n){if(this.resultCache.size>=Hn)this.resultCache.delete(this.resultCache.keys().next().value);this.resultCache.set(e,r)}return r}redactForDisplay(e){this.displayRules??=Fn();let n=e;for(let r of this.displayRules){if(r.confidence!=="high"||r.prefilter?.test(n)===!1)continue;n=n.replace(r.re,Wn)}return n}}var B=new wt;function g4o(e){return B.scan(e)}function Rs(e){return B.redact(e)}function mQ(e){return B.redactTokens(B.redactContext(e))}function fZn(e){return B.redactContext(e)}function fvn(e){return B.redactTokens(e)}var wPe=16384;function mZn(e,n){let r=fe(e);if(r.length===0)return Bn(B.redactContext(e,!0),n);let s=B.trackedContext(e,!0);for(let i=n+2*wPe;;i*=2){if(s.text.length<=i)return se(B.trackedTokens(s),r).text;let o=B.trackedTokens(Te(s,0,i)),a=o.text.length-wPe;if(a>=n){let u=re(o.text,a).length,l=se(Te(o,0,u),r);if(l.text.length>=n)return l.text}}}function Bn(e,n){for(let s=n+2*wPe;;s*=2){if(e.length<=s)return fvn(e);let i=fvn(e.slice(0,s)),o=i.length-wPe;if(o>=n)return re(i,o)}}var $n=/[$\x60|;&<>()\s]/,Un=/[/.@:~*?\\]/;function Wn(e,n){let r=typeof n==="string"?n:e;if($n.test(r)||Un.test(r))return e;return _e(e,n)}function LSe(e){return B.redactForDisplay(e)}function M4(e,n=Rs){if(typeof e==="string")return n(e);if(Array.isArray(e))return e.map((r)=>M4(r,n));if(e!==null&&typeof e==="object"){let r=Object.create(null),s=Object.entries(e),i=n===Rs?ys(s.map(([o])=>o)):void 0;for(let[o,[a,u]]of s.entries()){let l=i?i[o]:a;if(typeof u==="string"){if(n===Rs){r[l]=D6r(a,u);continue}let c=`${a}: `,d=n(c+u);r[l]=d.startsWith(c)?d.slice(c.length):n(u)}else r[l]=M4(u,n)}return r}return e}function D6r(e,n){let r=`${e}: `,s=r+n,i=fe(s);if(i.length===0){let u=Rs(s);if(u.startsWith(r))return u.slice(r.length);let l=mQ(s);return l.startsWith(r)?B.redactOnlyRules(l.slice(r.length)):Rs(n)}let o=[];for(let[u,l]of i)if(l>r.length)o.push([Math.max(u,r.length),l]);let a=B.trackedByRules(s,!0);if(a.text.startsWith(r))return se(a,o).text.slice(r.length);let c=B.trackedByRules(s);return c.text.startsWith(r)?B.redactOnlyRules(se(c,o).text.slice(r.length)):Rs(n)}function ys(e){let n=e.map((i)=>Rs(i));if(n.every((i,o)=>i===e[o]))return n;let r=new Set(n.filter((i,o)=>i===e[o])),s=new Map;return n.map((i,o)=>{if(i===e[o])return i;let a=i,u=s.get(i)??2;while(r.has(a))a=`${i} (${u})`,u++;return s.set(i,u),r.add(a),a})}function OGt(e){let n=Object.create(null);for(let[r,s]of Object.entries(e))n[r]=Fe.test(r)?"[REDACTED]":s;return n}
export { g4o, Rs, mQ, fZn, fvn, mZn, LSe, M4, D6r, OGt }
