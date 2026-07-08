import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const DEFAULT_REGION = 'us-east-1'

/**
 * /setup-bedrock — configure AWS Bedrock as the API provider.
 *
 * Writes the Bedrock provider env vars to ~/.claude/settings.json and shows
 * the user the remaining manual steps (AWS credentials, model selection).
 *
 * Usage:
 *   /setup-bedrock                    -> uses default region (us-east-1)
 *   /setup-bedrock us-west-2          -> sets AWS_REGION
 *   /setup-bedrock us-west-2 <model>  -> sets region + ANTHROPIC_MODEL
 */
const call: LocalCommandCall = async args => {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const region = parts[0] || DEFAULT_REGION
  const model = parts[1]

  const env: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: region,
  }
  if (model) {
    env.ANTHROPIC_MODEL = model
  }

  const { error } = updateSettingsForSource('userSettings', { env })
  if (error) {
    return {
      type: 'text',
      value: `Failed to write Bedrock config to ~/.claude/settings.json: ${error.message}`,
    }
  }

  const lines: string[] = [
    'AWS Bedrock provider configured in ~/.claude/settings.json:',
    '',
    `  CLAUDE_CODE_USE_BEDROCK = 1`,
    `  AWS_REGION              = ${region}`,
  ]
  if (model) {
    lines.push(`  ANTHROPIC_MODEL         = ${model}`)
  }
  lines.push(
    '',
    'Remaining steps to complete setup:',
    '',
    '1. AWS credentials — ensure one of the following is available:',
    '   - AWS CLI configured:  aws configure   (sets ~/.aws/credentials)',
    '   - Or export env vars:  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY',
    '   - Or an IAM role / SSO profile if running on AWS infrastructure.',
    '',
    '2. Model access — in the AWS Console (Bedrock > Model access), enable the',
    '   Claude models you intend to use for your account in this region.',
    '',
    '3. Model ID — Bedrock uses prefixed model IDs like:',
    '   - us.anthropic.claude-sonnet-4-20250514-v1:0',
    '   - anthropic.claude-3-5-sonnet-20241022-v1:0',
    '   Set ANTHROPIC_MODEL (or pass it as the 2nd arg above) to override.',
    '',
    '4. Restart Claude Code so the new env vars take effect.',
    '',
    'To switch back to the default Anthropic API, remove CLAUDE_CODE_USE_BEDROCK',
    'from settings.json or run:  /config',
  )

  return { type: 'text', value: lines.join('\n') }
}

const setupBedrock = {
  type: 'local',
  name: 'setup-bedrock',
  description: 'Configure AWS Bedrock as the API provider',
  argumentHint: '[aws-region] [model]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default setupBedrock
