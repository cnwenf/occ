// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.286 minified source (verbatim port)
// biome-ignore-all lint/correctness/noEmptyCharacterClassInRegex: [^] is the intentional JS any-char class in the official fe quoted-string detector (verbatim port)
/**
 * The secret-redaction engine (upstream class wt + singleton B).
 *
 * Ported verbatim from the official Claude Code 2.1.286 linux-x64 binary (npm pack + byte forensics, md5 7a1a1bf1223b8dc705fec6124dd82df1).
 * Pipeline: low-confidence context rules (redactContext) + high-confidence
 * token rules (redactTokens) + PEM blocks, with URL userinfo spans applied on
 * the ORIGIN-TRACKED document so a redaction span is never cut by slicing.
 * Display path (redactForDisplay) skips shell/URL-ish values.
 *
 * Public entry points (upstream export names):
 *   g4o - scan(text): [{ruleId,label}] without redacting
 *   Rs  - redact(text): full redaction (cached for short strings)
 *   mQ  - redactTokens(redactContext(text))
 *   fZn - redactContext (low-confidence rules + PEM)
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
import { Fe, St, On, ir } from './rules.js'
import { Dn, H6r, Et } from './pem.js'

var pt=`(?:[\\x60'"\\s;]|\\\\[nr]|$)`,mt="(?=[^a-zA-Z0-9_\\-+=]|$)",_n="(?<![a-zA-Z0-9_\\-])";function Fn(){return St.map((e)=>({id:e.id,confidence:e.confidence,re:new RegExp(e.confidence!=="high"?e.source:_n+(e.source.endsWith(pt)?e.source.slice(0,-pt.length)+mt:e.source+mt),(e.flags??"").replace("g","")+"g")}))}function ue(e){return St.map((n)=>({id:n.id,confidence:n.confidence,re:new RegExp(n.source,e?(n.flags??"").replace("g","")+"g":n.flags??"")}))}function _e(e,n){if(typeof n!=="string")return"[REDACTED]";let r=n.length>=2&&(n[0]==='"'||n[0]==="'")&&n.at(-1)===n[0]?n[0]:"",s=e.lastIndexOf(n);return`${e.slice(0,s)}${r}[REDACTED]${r}${e.slice(s+n.length)}`}function Cn(e){let n=e[1];if(typeof n!=="string")return{keep:0,insert:"[REDACTED]"};let r=n.length>=2&&(n[0]==='"'||n[0]==="'")&&n.at(-1)===n[0]?1:0,s=e[0].lastIndexOf(n);return{keep:s+r,insert:"[REDACTED]",keepEnd:e[0].length-s-n.length+r}}function fe(e){return dt(e,On).map(({start:n,end:r})=>{let s=/^(["'])[^]*\1$/.test(e.slice(n,r))?1:0;return[n+s,r-s]})}function se(e,n){let{text:r,origin:s}=e,i=[],o=0;for(let a=0;a<r.length;){let u=s[a];while(o<n.length&&n[o][1]<=u)o++;let l=n[o];if(u<0||l===void 0||u<l[0]){a++;continue}let c=a;while(c>0&&s[c-1]<0)c--;while(a<r.length&&(s[a]<0||s[a]>=l[0]&&s[a]<l[1]))a++;let f=i.at(-1);if(f!==void 0&&f[1]>=c)f[1]=a;else i.push([c,a,"[REDACTED]"])}return ie(e,i)}var Nn=512,Hn=512;class wt{testRules=null;redactRules=null;displayRules=null;resultCache=new Map;scan(e){this.testRules??=ue(!1);let n=[];for(let r of this.testRules)if(r.confidence==="high"&&r.re.test(e))n.push({ruleId:r.id,label:r.id.split("-").map((s)=>ir[s]??Su(s)).join(" ")});if(Dn(e))n.push({ruleId:"private-key",label:"Private Key"});return n}redactContext(e){this.redactRules??=ue(!0);let n=H6r(e);for(let r of this.redactRules)if(r.confidence==="low")n=n.replace(r.re,_e);return n}redactTokens(e){this.redactRules??=ue(!0);let n=e;for(let r of this.redactRules)if(r.confidence==="high")n=n.replace(r.re,_e);return n}trackedByRules(e){return this.trackedTokens(this.trackedContext(e))}trackedContext(e){let n=ie(ot(e),Et(e).map(({start:r,end:s})=>[r,s,"[REDACTED]"]));return this.trackedRules(n,"low")}trackedTokens(e){return this.trackedRules(e,"high")}trackedRules(e,n){this.redactRules??=ue(!0);let r=e;for(let s of this.redactRules)if(s.confidence===n)s.re.lastIndex=0,r=at(r,s.re,Cn);return r}redactWithUrlRanges(e){let n=fe(e);return n.length===0?this.redactTokens(this.redactContext(e)):se(this.trackedByRules(e),n).text}redactTracked(e){return se(this.trackedByRules(e),fe(e))}redact(e){let n=e.length<=Nn;if(n){let s=this.resultCache.get(e);if(s!==void 0)return s}let r=this.redactWithUrlRanges(e);if(n){if(this.resultCache.size>=Hn)this.resultCache.delete(this.resultCache.keys().next().value);this.resultCache.set(e,r)}return r}redactForDisplay(e){this.displayRules??=Fn();let n=e;for(let r of this.displayRules){if(r.confidence!=="high")continue;n=n.replace(r.re,Wn)}return n}}var B=new wt;function g4o(e){return B.scan(e)}function Rs(e){return B.redact(e)}function mQ(e){return B.redactTokens(B.redactContext(e))}function fZn(e){return B.redactContext(e)}function fvn(e){return B.redactTokens(e)}var wPe=16384;function mZn(e,n){let r=fe(e);if(r.length===0)return Bn(e,n);let s=B.trackedContext(e);for(let i=n+2*wPe;;i*=2){if(s.text.length<=i)return se(B.trackedTokens(s),r).text;let o=B.trackedTokens(Te(s,0,i)),a=o.text.length-wPe;if(a>=n){let u=re(o.text,a).length,l=se(Te(o,0,u),r);if(l.text.length>=n)return l.text}}}function Bn(e,n){let r=fZn(e);for(let s=n+2*wPe;;s*=2){if(r.length<=s)return fvn(r);let i=fvn(r.slice(0,s)),o=i.length-wPe;if(o>=n)return re(i,o)}}var $n=/[$\x60|;&<>()\s]/,Un=/[/.@:~*?\\]/;function Wn(e,n){let r=typeof n==="string"?n:e;if($n.test(r)||Un.test(r))return e;return _e(e,n)}function LSe(e){return B.redactForDisplay(e)}function M4(e,n=Rs){if(typeof e==="string")return n(e);if(Array.isArray(e))return e.map((r)=>M4(r,n));if(e!==null&&typeof e==="object"){let r=Object.create(null);for(let[s,i]of Object.entries(e))if(typeof i==="string"){if(n===Rs){r[s]=D6r(s,i);continue}let o=`${s}: `,a=n(o+i);r[s]=a.startsWith(o)?a.slice(o.length):n(i)}else r[s]=M4(i,n);return r}return e}function D6r(e,n){let r=`${e}: `,s=r+n,i=fe(s);if(i.length===0){let u=Rs(s);return u.startsWith(r)?u.slice(r.length):Rs(n)}let o=[];for(let[u,l]of i)if(l>r.length)o.push([Math.max(u,r.length),l]);let a=B.trackedByRules(s);if(!a.text.startsWith(r))return Rs(n);return se(a,o).text.slice(r.length)}function OGt(e){let n=Object.create(null);for(let[r,s]of Object.entries(e))n[r]=Fe.test(r)?"[REDACTED]":s;return n}
export { g4o, Rs, mQ, fZn, fvn, mZn, LSe, M4, D6r, OGt }
