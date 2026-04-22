/**
 * generate_diagram tool: writes a Mermaid diagram to a Markdown file.
 *
 * Accepts raw Mermaid source (no fencing) and wraps it in a ```mermaid
 * code block under an H1 heading. The output file is always written
 * inside the workspace root; absolute paths that escape the root are
 * rejected.
 */
import * as path from "path";
import * as fs from "fs/promises";
import type { Tool, ToolExecutionContext, ToolResult } from "./types";

export const generateDiagramTool: Tool = {
  name: "generate_diagram",
  description:
    "Write a Mermaid diagram to a Markdown file. Provide the Mermaid source code in `content` (no fencing — the tool adds it). Supported types: flowchart, sequenceDiagram, classDiagram, erDiagram, gantt, pie, gitgraph.",
  requiresApproval: true,
  parameters: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          "Output file path relative to workspace root, e.g. docs/auth-flow.md",
      },
      title: {
        type: "string",
        description: "Diagram title used as the H1 heading in the file",
      },
      diagramType: {
        type: "string",
        enum: [
          "flowchart",
          "sequenceDiagram",
          "classDiagram",
          "erDiagram",
          "gantt",
          "pie",
          "gitgraph",
        ],
        description: "Mermaid diagram type keyword",
      },
      content: {
        type: "string",
        description:
          "The Mermaid diagram source (without the ```mermaid fencing)",
      },
    },
    required: ["filename", "title", "diagramType", "content"],
  },

  async execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const { filename, title, diagramType, content } = args as {
      filename: string;
      title: string;
      diagramType: string;
      content: string;
    };

    // Relative paths are resolved against workspaceRoot.
    // Absolute paths must still fall inside workspaceRoot.
    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(ctx.workspaceRoot, filename);

    // Normalise the root so it always ends with a separator, which prevents
    // /tmp matching /tmpfoo or similar prefix collisions.
    const normalizedRoot = ctx.workspaceRoot.endsWith(path.sep)
      ? ctx.workspaceRoot
      : ctx.workspaceRoot + path.sep;

    if (!fullPath.startsWith(normalizedRoot)) {
      return {
        success: false,
        output: `Path "${filename}" is outside the workspace — not allowed.`,
      };
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    const markdown = `# ${title}\n\n\`\`\`mermaid\n${diagramType}\n${content}\n\`\`\`\n`;
    await fs.writeFile(fullPath, markdown, "utf-8");

    ctx.reportProgress(`Diagram written to ${filename}`);
    return {
      success: true,
      output: `Mermaid diagram written to ${filename}`,
      metadata: { filesCreated: [fullPath] },
    };
  },
};
