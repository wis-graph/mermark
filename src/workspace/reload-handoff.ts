const GLOBAL_VAULT_PARAM = "global";

export interface DocumentReloadHandoff {
  readonly file: string | null;
  readonly globalExplorerRoot: string | null;
}

export function createDocumentReloadUrl(file: string, globalExplorerRoot: string | null): string {
  const params = new URLSearchParams({ file });
  if (globalExplorerRoot !== null) {
    params.set("vault", GLOBAL_VAULT_PARAM);
    params.set("root", globalExplorerRoot);
  }
  return `index.html?${params.toString()}`;
}

export function readDocumentReloadHandoff(search: string): DocumentReloadHandoff {
  const params = new URLSearchParams(search);
  const root = params.get("vault") === GLOBAL_VAULT_PARAM ? params.get("root") : null;
  return {
    file: params.get("file"),
    globalExplorerRoot: root && root.length > 0 ? root : null,
  };
}
