/** Filtering and labels for the TUI's inline model picker. */

function subsequenceMatch(candidate: string, query: string): boolean {
  let index = 0;
  for (const char of candidate.toLowerCase()) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
}

export function filterModels(models: string[], filter: string): string[] {
  const query = filter.trim().toLowerCase();
  if (!query) return models;
  return models.filter(
    (model) =>
      model.toLowerCase().includes(query) || subsequenceMatch(model, query),
  );
}

/** Prefer the provider-qualified short name over a cache path or full id. */
export function modelLabel(model: string): string {
  if (model.startsWith("/")) {
    const parts = model.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? model;
  }
  const parts = model.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : model;
}
