import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

function getDataVizPrompt(args: string): string {
  const request = args.trim() || '(no specific request — ask the user what they want to visualize)'
  return `You are creating a data visualization based on the user's request.

## Approach

Produce visualizations using web-standard technologies that render in a browser context:

1. **HTML + inline SVG** — the default for static, self-contained charts (bar, line, pie, scatter, heatmaps, etc.). A single \`.html\` file with inline \`<svg>\` elements and minimal CSS works everywhere and requires no build step.

2. **React + a charting library** — when the project already uses React, prefer a component-based approach. Use a battle-tested charting library (e.g. Recharts, Nivo, Victory) over hand-rolled SVG when the chart type is well-supported.

3. **Inline SVG within the existing app** — for simple, one-off visuals that must live inside an existing React/JSX component.

## Design Principles

- **Read the data first.** Before writing any chart code, inspect the actual data: its shape, range, cardinality, and type (categorical vs. continuous, temporal vs. static). Choose a chart type that fits the data, not the other way around.
- **Pick the right chart type.** Bar for categorical comparisons, line for trends over time, scatter for correlations, stacked bar for part-to-whole, heatmap for density. Don't use a pie chart for more than 5-7 slices.
- **Accessible by default.** Include axis labels, a legend, units, and a title. Do not rely on color alone to encode meaning — pair color with direct labels or patterns. Ensure sufficient contrast.
- **Responsive.** Use \`viewBox\` on SVG so it scales. Avoid fixed pixel widths.
- **No external dependencies for the HTML/SVG path.** The output should open in any browser with zero setup.
- **Clean, minimal aesthetic.** Strip chartjunk (excessive gridlines, 3D effects, redundant borders). Let the data carry the visual weight.

## Output

The user's request: ${request}

Based on the data and the request:
1. Determine the appropriate visualization type and justify the choice in one sentence.
2. If data needs to be fetched or read, do that first (use the available file-reading and bash tools).
3. Produce the visualization. For HTML/SVG, write a single self-contained \`.html\` file. For React, write the component file(s) and note any required dependencies.
4. If possible, open the result so the user can see it immediately.
5. Explain how to view/extend the result in one or two lines.

If the user's request is ambiguous (no data source, unclear chart type), ask one or two focused clarifying questions before building.`
}

const dataviz = {
  type: 'prompt',
  name: 'dataviz',
  description: 'Create a data visualization (chart, graph, or plot)',
  argumentHint: '<description of what to visualize>',
  progressMessage: 'creating a data visualization',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: getDataVizPrompt(args) }]
  },
} satisfies Command

export default dataviz
