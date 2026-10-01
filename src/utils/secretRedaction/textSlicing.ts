/**
 * UTF-16-safe text slicing helpers for the secret-redaction engine.
 *
 * Ported verbatim from the official Claude Code 2.1.286 linux-x64 binary (npm pack + byte forensics, md5 7a1a1bf1223b8dc705fec6124dd82df1).
 * Upstream symbols (chunk-xjjs8j5r helpers region):
 *   Su  - capitalize first char (identical to utils/stringUtils.capitalize)
 *   re  - slice a prefix of at most n UTF-16 code units, never splitting a
 *         surrogate pair
 *   f/x - re-normalize a string cut mid-surrogate (Buffer utf16le roundtrip,
 *         with a pure-JS 8192-char-chunk fallback)
 * Only Su and re are consumed by the ported engine; the rest of the upstream
 * helper cluster (si/tc/P/qje/os/Jd/yQ) is not ported (unused here).
 */

function Su(t){return t.charAt(0).toUpperCase()+t.slice(1)}function re(t,n){if(n<=0)return"";if(t.length<=n)return t;let e=t.slice(0,n),r=e.charCodeAt(n-1);return f(r>=55296&&r<=56319?e.slice(0,-1):e)}function f(t){if(typeof Buffer<"u")return Buffer.from(t,"utf16le").toString("utf16le");return x(t)}function x(t){let e=[];for(let r=0;r<t.length;r+=8192){let i=Math.min(r+8192,t.length),o=new Uint16Array(i-r);for(let u=r;u<i;u++)o[u-r]=t.charCodeAt(u);e.push(String.fromCharCode(...o))}return e.join("")}
export { Su, re }
