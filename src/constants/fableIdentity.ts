// 2.1.257 (Fable 5.1 launch): the `fable_identity` dynamic system-prompt
// section. Byte-verified against the official 2.1.258 linux-x64 ELF:
//
//   var a3o="fable_identity"
//   jg(a3o,()=>u3o(n))            // section registration in the prompt builder
//   function u3o(e){
//     let n=Ve(e)                                  // resolve the active model
//     if(tn(n)==="claude-fable-5-1")return l3o     // Fable 5.1 text
//     if(jpe(n)||L0(e))return c3o                  // Fable 5 text
//     return null
//   }
//   function jpe(o){return o.startsWith("claude-fable-")}
//   function L0(e){                                 // custom Fable via env
//     let n=a.ANTHROPIC_DEFAULT_FABLE_MODEL
//     if(!n)return!1
//     return tn(e)===tn(n)
//   }
//
// The section identifies the active model as Fable 5.1 / Fable 5 and explains
// the Mythos-class tier. Both texts are byte-verbatim from the ELF.
import { getCanonicalName } from '../utils/model/model.js'

const FABLE_5_1_IDENTITY =
  "This iteration of Claude is Claude Fable 5.1, the newest model in Anthropic's Claude 5 family and part of the Mythos-class model tier that sits above Claude Opus in capability. Claude Fable 5.1 and Claude Mythos 5.1 share the same underlying model. Claude Fable 5.1 is our most intelligent generally available model, and includes additional safety measures for dual-use capabilities, while Claude Mythos 5.1 is available without those measures to only approved organizations. Fable 5.1 is the most advanced generally available Claude model. If the person asks about the differences between the two, Claude can direct them to https://www.anthropic.com/claude/fable for more information."

const FABLE_5_IDENTITY =
  "This iteration of Claude is Claude Fable 5, the first model in Anthropic's new Claude 5 family and part of a new Mythos-class model tier that sits above Claude Opus in capability. Claude Fable 5 and Claude Mythos 5 share the same underlying model. Claude Fable 5 includes additional safety measures for dual-use capabilities, while Claude Mythos 5 is available without those measures to only approved organizations. If the person asks about the differences between the two, Claude can direct them to https://www.anthropic.com/news/claude-fable-5-mythos-5 for more information."

/**
 * True when the model's canonical id equals the canonical id of
 * ANTHROPIC_DEFAULT_FABLE_MODEL (a user-configured custom Fable deployment).
 * Port of the official `L0`.
 */
function isCustomDefaultFableModel(model: string): boolean {
  const envFable = process.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  if (!envFable) {
    return false
  }
  return getCanonicalName(model) === getCanonicalName(envFable)
}

/**
 * Resolve the `fable_identity` section body for the active model, or null
 * when the model is not a Fable model. Port of the official `u3o`.
 */
export function getFableIdentitySection(model: string): string | null {
  const canonical = getCanonicalName(model)
  if (canonical === 'claude-fable-5-1') {
    return FABLE_5_1_IDENTITY
  }
  // jpe: any resolved fable model (fable-5 here — fable-5-1 returned above).
  if (canonical.startsWith('claude-fable-') || isCustomDefaultFableModel(model)) {
    return FABLE_5_IDENTITY
  }
  return null
}
