export type ConflictResolution = "external" | "mine" | "merged";
export type ConflictStatus = "pending" | "resolved";

export interface ConflictIdentity {
  readonly vaultId: string;
  readonly tabId: string;
  readonly documentId: string;
}

export const sameConflictIdentity = (left: ConflictIdentity, right: ConflictIdentity): boolean =>
  left.vaultId === right.vaultId && left.tabId === right.tabId && left.documentId === right.documentId;

export interface ConflictRecord {
  readonly identity: ConflictIdentity;
  readonly status: ConflictStatus;
  readonly localContent: string;
  readonly externalContent: string;
  readonly resolution: ConflictResolution | null;
  readonly resultContent: string | null;
  readonly resultVersion: number;
}

export class UnknownConflictError extends Error {
  readonly identity: ConflictIdentity;

  constructor(identity: ConflictIdentity) {
    super(`Unknown conflict: ${identity.vaultId}/${identity.tabId}/${identity.documentId}`);
    this.name = "UnknownConflictError";
    this.identity = identity;
  }
}

const identityKey = (identity: ConflictIdentity): string => JSON.stringify([
  identity.vaultId,
  identity.tabId,
  identity.documentId,
]);

export function mergeConflictText(local: string, external: string): string {
  if (local === external) return local;
  return ["<<<<<<< mine", local, "||||||| external", external, ">>>>>>> merged"].join("\n");
}

export interface ConflictRecovery {
  detect(identity: ConflictIdentity, localContent: string, externalContent: string): ConflictRecord;
  get(identity: ConflictIdentity): ConflictRecord | undefined;
  applyExternal(identity: ConflictIdentity): ConflictRecord;
  keepMine(identity: ConflictIdentity): ConflictRecord;
  merge(identity: ConflictIdentity): ConflictRecord;
}

export function createConflictRecovery(): ConflictRecovery {
  const records = new Map<string, ConflictRecord>();

  const detect = (identity: ConflictIdentity, localContent: string, externalContent: string): ConflictRecord => {
    const record: ConflictRecord = {
      identity,
      status: "pending",
      localContent,
      externalContent,
      resolution: null,
      resultContent: null,
      resultVersion: 0,
    };
    records.set(identityKey(identity), record);
    return record;
  };

  const resolve = (identity: ConflictIdentity, resolution: ConflictResolution, resultContent: string): ConflictRecord => {
    const current = records.get(identityKey(identity));
    if (!current) throw new UnknownConflictError(identity);
    const resolved: ConflictRecord = { ...current, status: "resolved", resolution, resultContent, resultVersion: current.resultVersion + 1 };
    records.set(identityKey(identity), resolved);
    return resolved;
  };

  return {
    detect,
    get: (identity) => records.get(identityKey(identity)),
    applyExternal: (identity) => {
      const current = records.get(identityKey(identity));
      if (!current) throw new UnknownConflictError(identity);
      return resolve(identity, "external", current.externalContent);
    },
    keepMine: (identity) => {
      const current = records.get(identityKey(identity));
      if (!current) throw new UnknownConflictError(identity);
      return resolve(identity, "mine", current.localContent);
    },
    merge: (identity) => {
      const current = records.get(identityKey(identity));
      if (!current) throw new UnknownConflictError(identity);
      return resolve(identity, "merged", mergeConflictText(current.localContent, current.externalContent));
    },
  };
}
