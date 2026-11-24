/** `champ review` command implementation shared with the TUI Review screen. */
import { CliReviewStore } from "./review-store";

export type ReviewCommand =
  | { name: "list"; id?: string }
  | { name: "show"; id: string }
  | { name: "accept"; id: string }
  | { name: "reject"; id: string };

export interface ReviewCommandDeps {
  workspace: string;
  store?: CliReviewStore;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export async function runReviewCommand(
  cmd: ReviewCommand,
  deps: ReviewCommandDeps,
): Promise<number> {
  const store = deps.store ?? new CliReviewStore(deps.workspace);
  try {
    if (cmd.name === "list") {
      const entries = await store.list();
      if (entries.length === 0) {
        deps.stdout("No recorded reviews.\n");
        return 0;
      }
      for (const entry of entries) {
        deps.stdout(
          `${entry.id}\t${entry.status}\t${entry.edits.length} file(s)\t${entry.createdAt}\n`,
        );
      }
      return 0;
    }

    const entry =
      cmd.name === "accept"
        ? await store.accept(cmd.id)
        : cmd.name === "reject"
          ? await store.reject(cmd.id)
          : await store.get(cmd.id);

    if (!entry) {
      deps.stderr(`champ: unknown review id "${cmd.id}"\n`);
      return 1;
    }
    if (cmd.name === "show") {
      deps.stdout(`${JSON.stringify(entry, null, 2)}\n`);
    } else {
      deps.stdout(`${entry.status} ${entry.id}\n`);
    }
    return 0;
  } catch (err) {
    deps.stderr(`champ: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
