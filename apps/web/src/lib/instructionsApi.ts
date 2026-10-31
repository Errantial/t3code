export interface InstructionFile {
  id: string;
  kind: "sync" | "optional";
  scope: "global" | "project";
  projectId?: string;
  title: string;
  filename?: string;
  content: string;
  revision: number;
  updatedAt: string;
}

export interface InstructionSyncTarget {
  provider: "codex" | "claude" | "opencode" | "cursor" | "custom";
  scope: "global" | "project";
  projectId?: string;
  environmentId?: string;
  workspaceRoot?: string;
  path?: string;
  filename?: string;
}

export interface ProjectInstructionProfile {
  projectId: string;
  mode: "shared" | "per-environment";
  shared: string[];
  environments: Record<string, string[]>;
  updatedAt: string;
}

export interface InstructionSync {
  id: string;
  fileId: string;
  targets: InstructionSyncTarget[];
  updatedAt: string;
}

export interface InstructionTargetStatus {
  path: string;
  exists: boolean;
  drift: boolean;
}

export interface InstructionSnapshot {
  version: 1;
  files: InstructionFile[];
  syncs: InstructionSync[];
  threadAttachments: Record<string, string[]>;
  targets: Record<string, InstructionTargetStatus[]>;
  profiles: Record<string, ProjectInstructionProfile>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "x-t3-orchestration-protocol": "2",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as T;
}

export function readInstructions(): Promise<InstructionSnapshot> {
  return call<InstructionSnapshot>("/api/instructions");
}

export function putInstruction(input: {
  id?: string;
  kind?: "sync" | "optional";
  scope?: "global" | "project";
  projectId?: string;
  title: string;
  filename?: string;
  content: string;
  expectedRevision?: number;
}): Promise<{ file: InstructionFile }> {
  return call("/api/instructions/files", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function putInstructionSync(input: {
  id?: string;
  fileId: string;
  targets: InstructionSyncTarget[];
}): Promise<{ sync: InstructionSync }> {
  return call("/api/instructions/syncs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function removeInstructionSync(id: string): Promise<{ removed: boolean }> {
  return call("/api/instructions/syncs/remove", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function putThreadAttachments(
  threadId: string,
  fileIds: string[],
): Promise<{ threadId: string; fileIds: string[] }> {
  return call("/api/instructions/attachments", {
    method: "POST",
    body: JSON.stringify({ threadId, fileIds }),
  });
}

export function putInstructionProfile(input: {
  projectId: string;
  mode: "shared" | "per-environment";
  shared?: string[];
  environments?: Record<string, string[]>;
}): Promise<{ profile: ProjectInstructionProfile }> {
  return call("/api/instructions/profile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function materializeInstructions(force = false): Promise<{
  written: Array<{ fileId: string; path: string }>;
  conflicts: Array<{ fileId: string; path: string }>;
}> {
  return call("/api/instructions/materialize", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
}
