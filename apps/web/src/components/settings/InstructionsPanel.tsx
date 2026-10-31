import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  type InstructionFile,
  type InstructionSnapshot,
  type InstructionSyncTarget,
  type ProjectInstructionProfile,
  materializeInstructions,
  putInstruction,
  putInstructionProfile,
  putInstructionSync,
  putThreadAttachments,
  readInstructions,
  removeInstructionSync,
} from "../../lib/instructionsApi";

interface Draft {
  id?: string;
  kind: "sync" | "optional";
  scope: "global" | "project";
  projectId: string;
  title: string;
  filename: string;
  content: string;
  revision?: number;
}

const emptyDraft = (): Draft => ({
  kind: "sync",
  scope: "global",
  projectId: "",
  title: "",
  filename: "",
  content: "",
});

function targetLine(target: InstructionSyncTarget): string {
  const path = target.provider === "custom" ? (target.path ?? "") : (target.filename ?? "");
  return [
    target.provider,
    target.scope,
    target.environmentId ?? "",
    target.workspaceRoot ?? "",
    path,
  ].join("|");
}

function parseTargets(value: string): InstructionSyncTarget[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [provider, scope, environmentId, workspaceRoot, path] = line
        .split("|")
        .map((part) => part.trim());
      if (
        !["codex", "claude", "opencode", "cursor", "custom"].includes(provider ?? "") ||
        (scope !== "global" && scope !== "project")
      ) {
        throw new Error(`Invalid target line: ${line}`);
      }
      return {
        provider: provider as InstructionSyncTarget["provider"],
        scope: scope as InstructionSyncTarget["scope"],
        ...(environmentId ? { environmentId } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(path ? (provider === "custom" ? { path } : { filename: path }) : {}),
      };
    });
}

const inputClass =
  "w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ring-inset";
const areaClass = `${inputClass} min-h-40 font-mono text-xs`;

export function InstructionsPanel() {
  const [snapshot, setSnapshot] = useState<InstructionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [syncText, setSyncText] = useState("");
  const [threadId, setThreadId] = useState("");
  const [threadFiles, setThreadFiles] = useState<string[]>([]);
  const [profileProjectId, setProfileProjectId] = useState("");
  const [profileMode, setProfileMode] = useState<"shared" | "per-environment">("shared");
  const [profileShared, setProfileShared] = useState<string[]>([]);
  const [profileEnvironments, setProfileEnvironments] = useState("");

  const refresh = async () => {
    try {
      const next = await readInstructions();
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  // The server owns the instruction library; this panel has no atom for it yet.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- initial snapshot load from the server-owned instruction library
  useEffect(() => {
    let cancelled = false;
    void readInstructions().then(
      (next) => {
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedSync =
    draft.id === undefined ? undefined : snapshot?.syncs.find((sync) => sync.fileId === draft.id);

  const files = snapshot?.files ?? [];
  const optionalFiles = files.filter((file) => file.kind === "optional");
  const targets = draft.id === undefined ? [] : (snapshot?.targets[draft.id] ?? []);

  const selectFile = (file: InstructionFile, source: InstructionSnapshot | null = snapshot) => {
    setDraft({
      id: file.id,
      kind: file.kind,
      scope: file.scope,
      projectId: file.projectId ?? "",
      title: file.title,
      filename: file.filename ?? "",
      content: file.content,
      revision: file.revision,
    });
    setSyncText(
      source?.syncs
        .find((sync) => sync.fileId === file.id)
        ?.targets.map(targetLine)
        .join("\n") ?? "",
    );
    setNotice(null);
    setError(null);
  };

  const saveFile = async () => {
    try {
      const result = await putInstruction({
        ...(draft.id === undefined ? {} : { id: draft.id }),
        kind: draft.kind,
        scope: draft.scope,
        ...(draft.projectId.trim() ? { projectId: draft.projectId.trim() } : {}),
        title: draft.title.trim(),
        ...(draft.filename.trim() ? { filename: draft.filename.trim() } : {}),
        content: draft.content,
        ...(draft.revision === undefined ? {} : { expectedRevision: draft.revision }),
      });
      const next = await refresh();
      const saved = next?.files.find((file) => file.id === result.file.id);
      if (saved) selectFile(saved, next);
      setNotice("Saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const saveSync = async () => {
    if (draft.id === undefined) return;
    try {
      await putInstructionSync({
        ...(selectedSync === undefined ? {} : { id: selectedSync.id }),
        fileId: draft.id,
        targets: parseTargets(syncText),
      });
      await refresh();
      setNotice("Sync targets saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const deleteSync = async () => {
    if (selectedSync === undefined) return;
    try {
      await removeInstructionSync(selectedSync.id);
      await refresh();
      setNotice("Sync targets removed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadThread = () => {
    setThreadFiles(snapshot?.threadAttachments[threadId.trim()] ?? []);
  };

  const saveThread = async () => {
    try {
      await putThreadAttachments(threadId.trim(), threadFiles);
      await refresh();
      setNotice(`Attachments saved for ${threadId.trim()}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const applyProfile = (profile: ProjectInstructionProfile | undefined) => {
    setProfileMode(profile?.mode ?? "shared");
    setProfileShared(profile?.shared ?? []);
    setProfileEnvironments(
      Object.entries(profile?.environments ?? {})
        .map(([environmentId, ids]) => `${environmentId}=${ids.join(",")}`)
        .join("\n"),
    );
  };

  const loadProfile = (source: InstructionSnapshot | null = snapshot) => {
    const profile = source?.profiles[profileProjectId.trim()];
    applyProfile(profile);
    setNotice(profile === undefined ? "No saved profile; showing defaults" : "Profile loaded");
  };

  const saveProfile = async () => {
    try {
      const environments = Object.fromEntries(
        profileEnvironments
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [environmentId, ids = ""] = line.split("=");
            return [
              (environmentId ?? "").trim(),
              ids
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
            ] as const;
          }),
      );
      await putInstructionProfile({
        projectId: profileProjectId.trim(),
        mode: profileMode,
        shared: profileShared,
        environments,
      });
      const next = await refresh();
      applyProfile(next?.profiles[profileProjectId.trim()]);
      setNotice("Project profile saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const materialize = async (force: boolean) => {
    try {
      const result = await materializeInstructions(force);
      await refresh();
      setNotice(
        result.conflicts.length === 0
          ? `Materialized ${result.written.length} target${result.written.length === 1 ? "" : "s"}`
          : `Stopped on ${result.conflicts.length} drifted target${result.conflicts.length === 1 ? "" : "s"}; review or force`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Instruction files">
        <p className="text-xs text-muted-foreground">
          Global and project AGENTS.md/CLAUDE.md files, plus role/context files for individual
          threads. Sync targets are generated copies; edit the file here, not the target.
        </p>
        <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraft(emptyDraft());
                setNotice(null);
                setError(null);
              }}
            >
              New file
            </Button>
            <div className="flex max-h-96 flex-col gap-1 overflow-auto rounded-md border border-border p-1">
              {files.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">No files yet.</p>
              ) : (
                files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => selectFile(file)}
                    className={`rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${
                      draft.id === file.id ? "bg-muted" : ""
                    }`}
                  >
                    <span className="block truncate font-medium">{file.title}</span>
                    <span className="block text-xs text-muted-foreground">
                      {file.scope}
                      {file.projectId ? `:${file.projectId}` : ""} · {file.kind} · r{file.revision}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium">
                Title
                <input
                  className={inputClass}
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Kind
                <select
                  className={inputClass}
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft({ ...draft, kind: event.target.value as Draft["kind"] })
                  }
                >
                  <option value="sync">Sync file</option>
                  <option value="optional">Optional (thread)</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Scope
                <select
                  className={inputClass}
                  value={draft.scope}
                  onChange={(event) =>
                    setDraft({ ...draft, scope: event.target.value as Draft["scope"] })
                  }
                >
                  <option value="global">Global</option>
                  <option value="project">Project</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Project id (optional)
                <input
                  className={inputClass}
                  value={draft.projectId}
                  onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium">
                Provider filename (optional)
                <input
                  className={inputClass}
                  value={draft.filename}
                  onChange={(event) => setDraft({ ...draft, filename: event.target.value })}
                  placeholder="AGENTS.md"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Content
              <textarea
                className={areaClass}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            </label>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" onClick={() => void saveFile()}>
                {draft.id === undefined ? "Create" : "Save"}
              </Button>
              {draft.revision !== undefined ? (
                <span className="text-xs text-muted-foreground">Revision {draft.revision}</span>
              ) : null}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Sync targets">
        <p className="text-xs text-muted-foreground">
          One target per line: provider|scope|environmentId|workspaceRoot|filename-or-path.
          Providers: codex, claude, opencode, cursor, custom. Environment id and workspace root are
          optional; custom uses the path field.
        </p>
        <textarea
          className={areaClass}
          value={syncText}
          onChange={(event) => setSyncText(event.target.value)}
          placeholder={"codex|global|||AGENTS.md\nclaude|project||/repo|CLAUDE.md"}
          disabled={draft.id === undefined}
        />
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={draft.id === undefined}
            onClick={() => void saveSync()}
          >
            Save sync targets
          </Button>
          {selectedSync ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void deleteSync()}>
              Remove sync
            </Button>
          ) : null}
        </div>
        {targets.length > 0 ? (
          <div className="mt-3 flex flex-col gap-1">
            {targets.map((target) => (
              <div key={target.path} className="flex items-center gap-2 text-xs">
                <span
                  className={`rounded px-1.5 py-0.5 ${target.drift ? "bg-warning-surface text-warning" : "bg-muted"}`}
                >
                  {target.drift ? "drift" : target.exists ? "ok" : "missing"}
                </span>
                <code className="truncate">{target.path}</code>
              </div>
            ))}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Project instruction profile">
        <p className="text-xs text-muted-foreground">
          One shared file set for every linked environment, or a per-environment selection.
          Environment ids match the linked environment. Thread optional files still layer on top.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-medium">
            Project id
            <input
              className={inputClass}
              value={profileProjectId}
              onChange={(event) => setProfileProjectId(event.target.value)}
              placeholder="project id"
            />
          </label>
          <Button type="button" size="sm" variant="outline" onClick={() => loadProfile()}>
            Load
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={profileProjectId.trim().length === 0}
            onClick={() => void saveProfile()}
          >
            Save profile
          </Button>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium">
            Mode
            <select
              className={inputClass}
              value={profileMode}
              onChange={(event) =>
                setProfileMode(event.target.value as "shared" | "per-environment")
              }
            >
              <option value="shared">Shared for every environment</option>
              <option value="per-environment">Per environment</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium">
            Per-environment selection
            <textarea
              className={`${areaClass} min-h-24`}
              value={profileEnvironments}
              onChange={(event) => setProfileEnvironments(event.target.value)}
              placeholder={"environment-id=file-id,file-id"}
              disabled={profileMode !== "per-environment"}
            />
          </label>
        </div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          {files.length === 0 ? (
            <p className="text-xs text-muted-foreground">No files yet.</p>
          ) : (
            files.map((file) => (
              <label key={file.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={profileShared.includes(file.id)}
                  disabled={profileMode !== "shared"}
                  onChange={(event) =>
                    setProfileShared((current) =>
                      event.target.checked
                        ? [...new Set([...current, file.id])]
                        : current.filter((id) => id !== file.id),
                    )
                  }
                />
                {file.title}
              </label>
            ))
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Materialize">
        <p className="text-xs text-muted-foreground">
          Rewrites every sync target from the stored files. Drifted targets stop the run unless you
          force it. The fleet mirror uses the same conflict rule.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void materialize(false)}>
            Materialize
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void materialize(true)}>
            Force materialize
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Thread attachments">
        <p className="text-xs text-muted-foreground">
          Attach optional instruction files to one thread. They are injected into later messages;
          MCP create_thread accepts optionalInstructionIds at creation.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs font-medium">
            Thread id
            <input
              className={inputClass}
              value={threadId}
              onChange={(event) => setThreadId(event.target.value)}
              placeholder="thread id"
            />
          </label>
          <Button type="button" size="sm" variant="outline" onClick={loadThread}>
            Load
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={threadId.trim().length === 0}
            onClick={() => void saveThread()}
          >
            Save attachments
          </Button>
        </div>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          {optionalFiles.length === 0 ? (
            <p className="text-xs text-muted-foreground">No optional files yet.</p>
          ) : (
            optionalFiles.map((file) => (
              <label key={file.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={threadFiles.includes(file.id)}
                  onChange={(event) =>
                    setThreadFiles((current) =>
                      event.target.checked
                        ? [...new Set([...current, file.id])]
                        : current.filter((id) => id !== file.id),
                    )
                  }
                />
                {file.title}
              </label>
            ))
          )}
        </div>
      </SettingsSection>

      {notice ? <p className="text-xs text-success">{notice}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </SettingsPageContainer>
  );
}
