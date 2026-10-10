// biome-ignore-all lint/complexity/noUselessStringRaw: String.raw escapes are byte-exact from the official 2.1.296 minified source (verbatim port)
/**
 * Secret-matching rule table for the redaction engine.
 *
 * Ported verbatim from the official Claude Code 2.1.296 linux-x64 binary
 * (evidence window @207293500..207316000, /tmp/cc296/ev-rules296.txt; the
 * 2.1.295 counterpart ev-rules295.txt is table-identical, so this closes the
 * 286->296 gap in one step).
 *
 * Mechanism of changelog bullets #17/#19 (v2.1.286), retained:
 *   - Fe: credential KEY-NAME regex, built through the zero-width-tolerant
 *     $Se builder so an invisible character smuggled inside a key name
 *     (e.g. "api<ZWSP>key") still matches (bullet #19).
 *   - An/Rn/Tn -> On: pattern families (auth-scheme-first "Bearer <token>",
 *     key=value assignment, cloud env var) consumed by the URL scanner's
 *     cursor walk (bullet #17: "Bearer"/"Basic" BEFORE the key name).
 *   - St: the full 64-rule table (low-confidence context rules + high-
 *     confidence provider token rules), each
 *     {id, source, confidence, flags?, prefilter?, redactOnly?, run?,
 *      displayRun?}.
 *   - ir: acronym capitalization map for human-readable rule labels.
 *
 * New in 2.1.295/2.1.296 (this port):
 *   - 64 rules (was 63 in 286): adds `sensitive-assign-escaped` with
 *     redactOnly:true + ESCAPED_QUOTE_RE prefilter (JSON written inside a
 *     shell string, e.g. \"api_key\":\"...\" - the 2.1.296 changelog fix).
 *   - `loose-jwt` rebuilt with lookbehind/lookahead boundaries + /eyJ/
 *     prefilter; `gcp-service-account` local part bounded to {1,64}.
 *   - `sensitive-assign` gains the bounded KEY_TAIL ({0,256} + negative
 *     lookahead) and SEP_GAP separator.
 *   - `run` field (anthropic-oauth-token) and `displayRun` field (11 gitlab
 *     rules) drive boundary-aware wrapped regexes in the engine builders.
 *   - Two-phase assign-scanner sources (PLAIN_NEXT_KEY / ESCAPED_NEXT_KEY /
 *     MASKED_TAIL / the three assign sources) exported for assignScanner.ts.
 *
 * Documented divergence: upstream BCo (single invisible-run RegExp) and oMs
 * (trailing separator test RegExp) are defined in the same chunk but only
 * consumed by modules OCC does not port - they are omitted here (same
 * omission as the 286-era M6r/m4o).
 */

import {
  INVISIBLE_CHARS as ape,
  INVISIBLE_RUN as jje,
  invisibleTolerantSource as $Se,
} from './invisibleChars.js'

// --- shared regex-source fragments (upstream st/le/xt/ft/gt/ht/K/de) ---
var Fe=new RegExp($Se(String.raw`api[_-]?key|secret|token|password|passwd|credential|bearer|authorization|auth[_-]?header|cookie|session[_-]?(?:id|key)|connection[_-]?string|(?:private|ssh|encryption|signing|access|deploy|master|license)[_-]?key|client[_-]?secret`),"i"),Pe=`[\\s\\u0085${ape}]`,xt=`(?:${$Se("Bearer|Basic")})[${ape}]*[\\s\\u0085]+`,ft="[^\\s\\u0085,;&}\\])]+",gt="(?![\\w\\[({$/+=~!@%^?\\\\-])",ht="\\n\\r\\x0b\\x0c\\u0085\\u2028\\u2029",K="[\\s\\u0085]",de=`"[^"${ht}]*"|'[^'${ht}]*'|"[^"]*"${gt}|'[^']*'${gt}|[^\\s-]{0,4}\\[REDACTED\\]['"\`]?|${xt}(?:\\[REDACTED\\]|${ft})|${ft}`

// --- URL-scanner pattern families (upstream Jr/Yr/Xr -> Qr; OCC name On) ---
var An={word:"\\b(?:Bearer|Basic)",tail:"",separator:`${K}+`,value:"[A-Za-z0-9+/=._~-]{20,}"},Rn={word:`(?:${Fe.source})`,tail:"[\\w.-]",separator:`["']?${K}*[=:]${K}*`,value:de},Tn={word:"\\b(?:AWS|GOOGLE|GCP|GCLOUD|AZURE)_\\w",tail:"\\w",separator:`${K}*[=:]${K}*`,value:de},On=[Rn,Tn,An]

// --- 295/296 assign + escaped-assign + next-key sources ---
// (upstream qr/M/U/es/cn/it/dn/qe/et/fn/Zr/nn/gn/Z/ts/ns/pn)
var Pn=["sk","ant","api"].join("-"),RUN_CHAR="[\\w=-]",H=`${RUN_CHAR}{20,}(?:\\.[0-9a-z]{9})?`,KEY_TAIL="[\\w.-]{0,256}(?![\\w.-])",SEP_GAP=`${K}*(?!${K})`,KEY_WITH_TAIL=`(?:${Fe.source})${KEY_TAIL}`,CLOUD_ENV_KEY=`\\b(?:${$Se("AWS|GOOGLE|GCP|GCLOUD|AZURE")})${jje}_\\w+`,SENSITIVE_ASSIGN_SOURCE=`${KEY_WITH_TAIL}(?:${jje}["'])?${Pe}*[=:]${SEP_GAP}(${de})`,CLOUD_ENV_VAR_SOURCE=`${CLOUD_ENV_KEY}${Pe}*[=:]${K}*(${de})`,ESCAPED_QUOTE_RE=/\\["']/,ESCAPED_STRING_VALUE=`\\\\+(?:"[^"${ht}]*(?<!\\\\)(?=\\\\+")|'[^'${ht}]*(?<!\\\\)(?=\\\\+'))`,ESCAPED_BARE_VALUE=`[^\\s\\u0085,;&})"'\\\\]+`,SENSITIVE_ASSIGN_ESCAPED_SOURCE=`${KEY_WITH_TAIL}${jje}\\\\+["']${Pe}*[=:]${SEP_GAP}(${ESCAPED_STRING_VALUE}|${xt}${ESCAPED_BARE_VALUE}|${ESCAPED_BARE_VALUE}|\\\\+["'][^\\s\\u0085,;&})"'\\\\]*)`,NEXT_KEY_BODY=`[^\\s\\u0085,;&}\\])"']{0,64}?(?:${KEY_WITH_TAIL}|${CLOUD_ENV_KEY})`,PLAIN_NEXT_KEY_SOURCE=`(?:${xt})?(?:[{[(]{0,8}(?:"${NEXT_KEY_BODY}"|'${NEXT_KEY_BODY}')|${NEXT_KEY_BODY})${Pe}*[=:]`,ESCAPED_NEXT_KEY_SOURCE=`(?:${xt})?(?:[{[(]{0,8}(?:"${NEXT_KEY_BODY}"|'${NEXT_KEY_BODY}'|\\\\+"${NEXT_KEY_BODY}\\\\+"|\\\\+'${NEXT_KEY_BODY}\\\\+')|${NEXT_KEY_BODY})${Pe}*[=:]`,MASKED_TAIL="\\][^\\s\"'>}|,;&`)\\]]*"

// --- 295/296 loose-jwt source (upstream me/tt/rn/ot) ---
var JWT_CHAR="[A-Za-z0-9_-]",JWT_SEG=`${JWT_CHAR}{10}${JWT_CHAR}*`,JWT_DOTS=`\\.${JWT_SEG}\\.${JWT_SEG}`,LOOSE_JWT_SOURCE=`(?<!${JWT_CHAR})(?=${JWT_CHAR}+${JWT_DOTS})(?:${JWT_CHAR}*?-)??(eyJ${JWT_SEG}${JWT_DOTS})`

// --- the 64-rule table (upstream hn), verbatim 2.1.296 ---
var St=[{id:"url-userinfo",source:`:\\/\\/((["'])[^/@\\s]*\\2(?=@)|(?:[^/@\\s"'|,;&\`]+(?=@))|[^/@\\s"'|,;&\`]*["'|,;&\`][^/@\\s]*@)@?`,confidence:"low"},{id:"gcp-service-account",source:"\\b([a-z0-9-]{1,64}@[a-z0-9-]+\\.iam\\.gserviceaccount\\.com)\\b",flags:"i",confidence:"low"},{id:"loose-anthropic-key",source:"\\b(sk-ant-?[\\w-]{10,})",confidence:"low"},{id:"http-auth-scheme",source:`\\b${xt}([A-Za-z0-9+/=._~-]{20,})`,flags:"i",confidence:"low"},{id:"loose-jwt",prefilter:/eyJ/,source:LOOSE_JWT_SOURCE,confidence:"low"},{id:"sensitive-assign",source:SENSITIVE_ASSIGN_SOURCE,flags:"i",confidence:"low"},{id:"cloud-env-var",source:CLOUD_ENV_VAR_SOURCE,flags:"i",confidence:"low"},{id:"url-userinfo-tail",source:":\\/\\/(\\[REDACTED\\](?!@|%40[^\\s\"'>}|,;&`)\\]@/]*(?:[\\s\"'>}|,;&`)\\]/]|$))[^\\s\"'>}|,;&`)\\]]*?(?=[\\s\"'>}|,;&`)\\]]|:\\/\\/|$))",confidence:"low"},{id:"url-userinfo-later-at",source:":\\/\\/(\\[REDACTED\\]@(?:[^\\s:/?#\"'>}|,;&`)\\]]|:(?!\\/\\/)){0,256})(?=@|%40)",confidence:"low"},{id:"url-userinfo-encoded",source:":\\/\\/((?:\\[REDACTED\\]@)?(?:(?:[^/?#@\\s\"',;&<>|)\\]{}`[]*[\"'`<>{}[\\]][^/?#@\\s,;&|{}\"'`<>[\\]()]*(?=%40))|[^/?#@\\s\"',;&<>|)\\]}`[]+(?=%40)|(?=[^/?#@\\s\"',;&<>|)\\]}`[]*?(?:%|:[^/?#@\\s\"',;&<>|)\\]}`[]))[^/?#@\\s\"',;&<>|)\\]}`[]+(?=\\[REDACTED\\])))",confidence:"low"},{id:"masked-value-rest",source:`\\[REDACTED\\](${MASKED_TAIL})`,confidence:"low"},{id:"sensitive-assign-escaped",redactOnly:!0,prefilter:ESCAPED_QUOTE_RE,source:SENSITIVE_ASSIGN_ESCAPED_SOURCE,flags:"i",confidence:"low"},{id:"aws-access-token",source:"\\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b",confidence:"high"},{id:"gcp-api-key",source:"\\b(AIza[\\w-]{35})(?![\\w-])",confidence:"high"},{id:"google-oauth-client-secret",source:"\\bGOCSPX-[\\w-]{28}(?![\\w-])",confidence:"high"},{id:"azure-ad-client-secret",source:`(?:^|[\\\\'"\\x60\\s>=:(,)])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?:$|[\\\\'"\\x60\\s<),])`,confidence:"high"},{id:"digitalocean-pat",source:`\\b(dop_v1_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"digitalocean-access-token",source:`\\b(doo_v1_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"anthropic-api-key",source:`\\b(${Pn}03-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"anthropic-admin-api-key",source:`\\b(sk-ant-admin01-[a-zA-Z0-9_\\-]{93}AA)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"anthropic-oauth-token",source:`\\b(sk-ant-(?:oat|ort)\\d{2}-[\\w-]{20,})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,run:"[\\w-]",confidence:"high"},{id:"openai-api-key",source:"sk-[A-Za-z0-9_-]{8,200}T3BlbkFJ[A-Za-z0-9_-]{8,200}",confidence:"high"},{id:"openai-legacy-api-key",source:"\\bsk-[a-zA-Z0-9]{48}(?![a-zA-Z0-9])",confidence:"high"},{id:"huggingface-access-token",source:`\\b(hf_[a-zA-Z]{34})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"supabase-secret-key",source:"\\bsb_secret_[A-Za-z0-9_-]{20,}",confidence:"high"},{id:"supabase-access-token",source:"\\bsbp_[a-z0-9]{40,}",confidence:"high"},{id:"github-pat",source:"ghp_[0-9a-zA-Z]{36}",confidence:"high"},{id:"github-fine-grained-pat",source:"github_pat_\\w{82}",confidence:"high"},{id:"github-app-token",source:"(?:ghu|ghs)_[0-9a-zA-Z]{36}",confidence:"high"},{id:"github-oauth",source:"gho_[0-9a-zA-Z]{36}",confidence:"high"},{id:"github-refresh-token",source:"ghr_[0-9a-zA-Z]{36}",confidence:"high"},{id:"gitlab-pat",source:`glpat-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-deploy-token",source:`gldt-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-runner-authentication-token",source:`glrt-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-oauth-app-secret",source:`gloas-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-pipeline-trigger-token",source:`glptt-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-kubernetes-agent-token",source:`glagent-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-incoming-mail-token",source:`glimt-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-scim-oauth-token",source:`glsoat-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-ci-build-token",source:`glcbt-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-feed-token",source:`glft-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"gitlab-feature-flag-client-token",source:`glffct-${H}`,displayRun:RUN_CHAR,confidence:"high"},{id:"slack-bot-token",source:"xoxb-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*",confidence:"high"},{id:"slack-user-token",source:"xox[a-z](?:-[0-9]{10,13}){3}-[a-zA-Z0-9-]{28,34}",confidence:"high"},{id:"slack-rotation-token",source:"xoxe(?:\\.xox[a-z])?-[0-9]-[A-Za-z0-9-]{28,}",confidence:"high"},{id:"slack-app-token",source:"xapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+",flags:"i",confidence:"high"},{id:"slack-workflow-token",source:"\\bxwfp-[a-zA-Z0-9-]{20,}",confidence:"high"},{id:"slack-webhook-url",source:"(?:https?://)?hooks\\.slack\\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/_-]{40,}",flags:"i",confidence:"high"},{id:"twilio-api-key",source:"SK[0-9a-fA-F]{32}",confidence:"high"},{id:"sendgrid-api-token",source:`\\b(SG\\.[a-zA-Z0-9=_\\-.]{66})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"npm-access-token",source:`\\b(npm_[a-zA-Z0-9]{36})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"pypi-upload-token",source:"pypi-AgEIcHlwaS5vcmc[\\w-]{50,1000}",confidence:"high"},{id:"databricks-api-token",source:`\\b(dapi[a-f0-9]{32}(?:-\\d)?)(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"hashicorp-tf-api-token",source:"[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}",confidence:"high"},{id:"pulumi-api-token",source:`\\b(pul-[a-f0-9]{40})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"postman-api-token",source:`\\b(PMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"grafana-api-key",source:`\\b(eyJrIjoi[A-Za-z0-9+/]{70,400}={0,3})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"grafana-cloud-api-token",source:`\\b(glc_[A-Za-z0-9+/]{32,400}={0,3})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"grafana-service-account-token",source:`\\b(glsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"sentry-user-token",source:`\\b(sntryu_[a-f0-9]{64})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"sentry-org-token",source:"\\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}",confidence:"high"},{id:"stripe-access-token",source:`\\b((?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99})(?:[\\x60'"\\s;]|\\\\[nr]|$)`,confidence:"high"},{id:"shopify-access-token",source:"shpat_[a-fA-F0-9]{32}",confidence:"high"},{id:"shopify-shared-secret",source:"shpss_[a-fA-F0-9]{32}",confidence:"high"}]

// --- acronym capitalization map for rule labels (upstream ir) ---
var ir={aws:"AWS",gcp:"GCP",api:"API",pat:"PAT",ad:"AD",tf:"TF",oauth:"OAuth",npm:"NPM",pypi:"PyPI",jwt:"JWT",ci:"CI",scim:"SCIM",github:"GitHub",gitlab:"GitLab",openai:"OpenAI",digitalocean:"DigitalOcean",huggingface:"HuggingFace",hashicorp:"HashiCorp",sendgrid:"SendGrid"}

export {
  Fe,
  St,
  On,
  ir,
  SENSITIVE_ASSIGN_SOURCE,
  CLOUD_ENV_VAR_SOURCE,
  SENSITIVE_ASSIGN_ESCAPED_SOURCE,
  PLAIN_NEXT_KEY_SOURCE,
  ESCAPED_NEXT_KEY_SOURCE,
  MASKED_TAIL,
  ESCAPED_QUOTE_RE,
  xt as AUTH_SCHEME_SOURCE,
}
