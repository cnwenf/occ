// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.286 minified source (verbatim port)
/**
 * Origin-tracked document: a text string plus a parallel Int32Array mapping
 * every output character back to its index in the original input (-1 for
 * inserted replacement text). Redactions applied to a tracked doc can later be
 * spliced back onto the ORIGINAL string by origin range, so slicing never cuts
 * a redaction span in half.
 *
 * Ported verbatim from the official Claude Code 2.1.286 linux-x64 binary (npm pack + byte forensics, md5 7a1a1bf1223b8dc705fec6124dd82df1).
 * Mechanism of changelog bullet #18 (v2.1.286). Upstream symbols:
 *   ot - create identity origin map
 *   at - regex matchAll over a tracked doc, splicing callback results
 *   ie - splice [start,end,replacement] spans into a tracked doc
 *   Te - slice a tracked doc (text + origin)
 */

function ot(e){let n=new Int32Array(e.length);for(let r=0;r<e.length;r++)n[r]=r;return{text:e,origin:n}}function at(e,n,r){let s=[];for(let i of e.text.matchAll(n)){let{keep:o,insert:a,keepEnd:u=0}=r(i),l=i.index??0,c=i[0].length,f=Math.min(Math.max(o|0,0),c),p=Math.min(Math.max(u|0,0),c-f);s.push([l+f,l+c-p,a])}return ie(e,s)}function ie(e,n){if(n.length===0)return e;let{text:r,origin:s}=e,i=r.length;for(let[c,f,p]of n)i+=p.length-(f-c);let o=new Int32Array(i),a=[],u=0,l=0;for(let[c,f,p]of n)a.push(r.slice(u,c)),o.set(s.subarray(u,c),l),l+=c-u,a.push(p),o.fill(-1,l,l+p.length),l+=p.length,u=f;return a.push(r.slice(u)),o.set(s.subarray(u),l),{text:a.join(""),origin:o}}function Te(e,n,r){return{text:e.text.slice(n,r),origin:e.origin.slice(n,r)}}
export { ot, at, ie, Te }
