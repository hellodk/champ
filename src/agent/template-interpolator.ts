/**
 * TemplateInterpolator: replaces {{key.path}} placeholders in strings
 * with values from a SharedMemory snapshot.
 *
 * Null/undefined values are replaced with "(not available)" and recorded
 * in the warnings array so the TeamRunner can surface them to the user.
 */

export class TemplateInterpolator {
  readonly warnings: string[] = [];

  interpolate(template: string, memory: Record<string, unknown>): string {
    return template.replace(/\{\{([\w.]+)\}\}/g, (_match, path: string) => {
      const value = this.resolvePath(path, memory);
      if (value === null || value === undefined) {
        this.warnings.push(
          `Template variable "{{${path}}}" resolved to null/undefined — replaced with "(not available)"`,
        );
        return "(not available)";
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    });
  }

  private resolvePath(path: string, obj: Record<string, unknown>): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}
