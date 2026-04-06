/**
 * FileAgent: processes user-uploaded files.
 *
 * Receives file blobs (via AgentInput or SharedMemory), parses them
 * into text, chunks them, and makes them available as ContextChunks
 * to downstream agents.
 *
 * The full parsing pipeline (PDF extraction, log chunking, etc.)
 * lives in src/upload/. This agent is the workflow-side entry point
 * that wraps that service.
 */
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
  ContextChunk,
} from "./types";

export interface UploadedFile {
  name: string;
  content: string;
  mimeType: string;
}

export class FileAgent implements Agent {
  readonly name = "file";
  readonly role = "parses and chunks user-uploaded files";

  async execute(
    _input: AgentInput,
    memory: SharedMemory,
  ): Promise<AgentOutput> {
    // Uploaded files are placed into shared memory under the 'uploads' key
    // by the UI layer before the workflow starts.
    const uploads = (memory.get("uploads") ?? []) as UploadedFile[];

    if (uploads.length === 0) {
      const empty: AgentOutput = {
        success: true,
        output: "No uploaded files to process",
        chunks: [],
      };
      memory.setOutput(this.name, empty);
      return empty;
    }

    const chunks: ContextChunk[] = uploads.map((file) => ({
      filePath: `upload://${file.name}`,
      text: file.content,
      startLine: 1,
      endLine: file.content.split("\n").length,
    }));

    const result: AgentOutput = {
      success: true,
      output: `Processed ${uploads.length} uploaded file(s)`,
      chunks,
    };
    memory.setOutput(this.name, result);
    return result;
  }
}
