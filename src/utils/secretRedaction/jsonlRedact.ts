// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.286 minified source (verbatim port)
/**
 * JSONL-safe transcript redaction (changelog bullet #21, v2.1.286).
 *
 * Ported verbatim from the official Claude Code 2.1.286 linux-x64 binary (npm pack + byte forensics, md5 7a1a1bf1223b8dc705fec6124dd82df1).
 * Upstream pipeline: uOe splits the transcript into lines, hr drops
 * "api-request" lines entirely and withholds lines whose type cannot be
 * determined; zr then redacts each remaining line: parse -> deep-redact the
 * JSON structure (jt: per-key state machine over credentialProperty /
 * credentialPropertyNames / propertyNames, 64-hex request-id scrubbing via
 * Nt/Wr) -> RE-SERIALIZE, so every output line stays valid JSON. Unparseable
 * lines fall back to whole-line text redaction. wkn = zr(uOe(text)).
 *
 * Documented divergences (upstream helpers live in chunks OCC does not port;
 * behavior is fully constrained by the call sites, which ARE verbatim):
 *   b  - upstream wraps JSON.stringify with telemetry instrumentation
 *        (chunk-6w550002.js); instrumentation stripped here.
 *   Vo - verbatim JSON.parse wrapper (chunk-xjjs8j5r.js @40796824).
 *   L  - record guard (chunk-v67w5hxq.js); only consumer does
 *        L(u) ? u.type : void 0, so a plain object check is equivalent.
 *   ft - lenient line parser (chunk-a8hvh7yb.js); only consumer (zr) treats
 *        null as "not JSON -> redact whole line", so parse-or-null is exact.
 * NOTE for OCC: /feedback in OCC files a GitHub issue instead of saving a
 * zip, so the upstream zip-assembly consumer (vkn) is a NO-OP here; this
 * module is ported for parity and is used by the feedback prompt builder.
 */

import { Rs, D6r, OGt } from './engine.js'

// --- divergence shims (see header) ---
function b(e, n?, r?) {
  return JSON.stringify(e, n, r)
}
function Vo(e) {
  return JSON.parse(e)
}
function L(e) {
  return typeof e === 'object' && e !== null
}
function ft(e, n) {
  try {
    return JSON.parse(e)
  } catch {
    return null
  }
}
var ks = 'api-request',
  _r = `"type":"${ks}`

function uOe(e){let s=[];for(let r of e.split(`
`)){let u=hr(r);if(u!==void 0)s.push(u)}return s.join(`
`)}function hr(e){let s=0;while(e.charCodeAt(s)===0||e.charCodeAt(s)===65279)s++;let r=s>0?e.slice(s):e;if(r.trim()==="")return e;let u;try{u=Vo(r)}catch{u=void 0}let n=L(u)?u.type:void 0;if(typeof n==="string"&&n.startsWith(ks))return;if(typeof n!=="string"||e.includes(_r))return b({type:"line-withheld",bytes:Buffer.byteLength(e)});return e}
var Is=new Set(["type","description","title"]);function vs(e){return typeof e==="string"||e!==null&&typeof e==="object"?"[REDACTED]":e}var Wr=/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;function Nt(e,s){return s.includes("api-request")?e.replace(Wr,"[REDACTED]"):e}function jt(e,s="data"){if(typeof e==="string")return Nt(Rs(e),e);if(Array.isArray(e))return e.map((n)=>jt(n));if(e===null||typeof e!=="object")return e;let r="type"in e&&e.type==="object",u=Object.create(null);for(let[n,p]of Object.entries(e)){let T=p!==null&&typeof p==="object"&&!Array.isArray(p),h=!1,A="data";if(s==="credentialProperty")if(T&&(n==="items"||n==="properties"&&r))A=n==="items"?"credentialProperty":"credentialPropertyNames";else if(Is.has(n)&&Array.isArray(p)){u[Rs(n)]=p.map((S)=>typeof S==="string"?Rs(S):vs(S));continue}else h=!Is.has(n)||T;else if(s==="credentialPropertyNames")h=!T,A="credentialProperty";else if(s==="propertyNames"&&T)A=OGt({[n]:""})[n]==="[REDACTED]"?"credentialProperty":"data";else if(n==="properties"&&T&&r)A="propertyNames";else h=OGt({[n]:""})[n]==="[REDACTED]";if(h)u[Rs(n)]=vs(p);else if(typeof p==="string")u[Rs(n)]=Nt(D6r(n,p),p);else u[Rs(n)]=jt(p,A)}return u}function $qt(e){return jt(e)}function zr(e){return e.split(`
`).map((s)=>{if(!s)return s;let r=ft(s,!1);if(r===null)return Nt(Rs(s),s);try{return b(jt(r))}catch{return Nt(Rs(s),s)}}).join(`
`)}function wkn(e){return zr(uOe(e))}
export { zr, wkn, $qt }
