import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'

const DEFAULT_REGION = 'us-east5'

/**
 * /setup-vertex — configure Google Vertex AI as the API provider.
 *
 * Writes the Vertex provider env vars to ~/.claude/settings.json and shows
 * the user the remaining manual steps (GCP credentials, project, model).
 *
 * Usage:
 *   /setup-vertex <project-id>                 -> uses default region (us-east5)
 *   /setup-vertex <project-id> <region>        -> sets project + region
 *   /setup-vertex <project-id> <region> <model>-> sets project + region + model
 *
 * If no project ID is given, writes the provider flag + region only and
 * instructs the user to set the project.
 */
const call: LocalCommandCall = async args => {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const projectId = parts[0]
  const region = parts[1] || DEFAULT_REGION
  const model = parts[2]

  const env: Record<string, string> = {
    CLAUDE_CODE_USE_VERTEX: '1',
    CLOUD_ML_REGION: region,
  }
  if (projectId) {
    env.ANTHROPIC_VERTEX_PROJECT_ID = projectId
  }
  if (model) {
    env.ANTHROPIC_MODEL = model
  }

  const { error } = updateSettingsForSource('userSettings', { env })
  if (error) {
    return {
      type: 'text',
      value: `Failed to write Vertex config to ~/.claude/settings.json: ${error.message}`,
    }
  }

  const lines: string[] = [
    'Google Vertex AI provider configured in ~/.claude/settings.json:',
    '',
    '  CLAUDE_CODE_USE_VERTEX     = 1',
    `  CLOUD_ML_REGION            = ${region}`,
  ]
  if (projectId) {
    lines.push(`  ANTHROPIC_VERTEX_PROJECT_ID = ${projectId}`)
  } else {
    lines.push('  ANTHROPIC_VERTEX_PROJECT_ID = (not set — see step 1)')
  }
  if (model) {
    lines.push(`  ANTHROPIC_MODEL            = ${model}`)
  }
  lines.push(
    '',
    'Remaining steps to complete setup:',
    '',
    '1. GCP project — set your Google Cloud project ID:',
    projectId
      ? '   (already set above)'
      : '   Re-run:  /setup-vertex <your-gcp-project-id>  ' +
        'or add ANTHROPIC_VERTEX_PROJECT_ID to settings.json',
    '',
    '2. GCP credentials — authenticate with Application Default Credentials:',
    '   gcloud auth application-default login',
    '   (or, if on GCE/GKE, the metadata server provides credentials automatically)',
    '',
    '3. Enable the Claude API — ensure the Vertex AI API is enabled for your',
    '   project in the Google Cloud Console.',
    '',
    '4. Model ID — Vertex uses the same model IDs as the Anthropic API, e.g.:',
    '   - claude-sonnet-4-20250514',
    '   - claude-3-5-sonnet-20241022',
    '   Set ANTHROPIC_MODEL (or pass it as the 3rd arg above) to override.',
    '',
    '5. Restart Claude Code so the new env vars take effect.',
    '',
    'To switch back to the default Anthropic API, remove CLAUDE_CODE_USE_VERTEX',
    'from settings.json or run:  /config',
  )

  return { type: 'text', value: lines.join('\n') }
}

const setupVertex = {
  type: 'local',
  name: 'setup-vertex',
  description: 'Configure Google Vertex AI as the API provider',
  argumentHint: '[gcp-project-id] [region] [model]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default setupVertex
