// biome-ignore-all lint/complexity/noCommaOperator: comma operators are byte-exact from the official 2.1.286 minified source (verbatim port)
/**
 * PEM private-key block detection and redaction.
 *
 * Ported verbatim from the official Claude Code 2.1.286 linux-x64 binary (npm pack + byte forensics, md5 7a1a1bf1223b8dc705fec6124dd82df1).
 *   Ln  - line length constant (64)
 *   De  - find BEGIN/END PRIVATE KEY block pairs
 *   Dn  - hasPrivateKey predicate (used by the engine's scan())
 *   H6r - replace every PEM private-key block with [REDACTED]
 *   Et  - fast "-----" prefilter scan returning PEM block spans
 */

var Ln=64;function De(e,n){let r=/-----BEGIN[ A-Z0-9_-]{0,100}?PRIVATE KEY(?: BLOCK)?-----/gi,s=/-----END[ A-Z0-9_-]{0,100}?PRIVATE KEY(?: BLOCK)?-----/gi;r.lastIndex=n;let i=r.exec(e);if(!i)return null;s.lastIndex=i.index+i[0].length+Ln;let o=s.exec(e);if(!o)return null;return{start:i.index,end:o.index+o[0].length}}function Dn(e){return De(e,0)!==null}function H6r(e){let n=Et(e);if(n.length===0)return e;let r="",s=0;for(let i of n)r+=e.slice(s,i.start)+"[REDACTED]",s=i.end;return r+e.slice(s)}function Et(e){let n=e.indexOf("-----");while(n!==-1){while(e.charCodeAt(n+5)===45)n++;if((e.charCodeAt(n+5)|32)===98&&(e.charCodeAt(n+6)|32)===101&&(e.charCodeAt(n+7)|32)===103&&(e.charCodeAt(n+8)|32)===105&&(e.charCodeAt(n+9)|32)===110)break;n=e.indexOf("-----",n+5)}let r=[];if(n===-1)return r;for(let s=De(e,n);s;s=De(e,s.end))r.push(s);return r}
export { Dn, H6r, Et }
