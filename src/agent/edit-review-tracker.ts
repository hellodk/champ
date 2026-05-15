export interface EditRecord {
  path: string;
  oldContent: string;
  newContent: string;
}

export class EditReviewTracker {
  private edits: EditRecord[] = [];

  record(edit: EditRecord): void {
    const existing = this.edits.find((e) => e.path === edit.path);
    if (existing) {
      existing.newContent = edit.newContent;
    } else {
      this.edits.push(edit);
    }
  }

  flush(): EditRecord[] {
    return [...this.edits];
  }

  reset(): void {
    this.edits = [];
  }

  get count(): number {
    return this.edits.length;
  }
}
