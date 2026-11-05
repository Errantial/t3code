import type { SwarmMap, SwarmMemberInput } from "@t3tools/contracts";

// Swarm v2 `map` (SW-A3c): one member per row, expanded before validation so every
// swarm_create rule applies to the expanded members. Values are substituted as plain text.

const TASK_MAX_CHARACTERS = 120_000;
const TITLE_MAX_CHARACTERS = 512;

/** `{{{{` is a literal `{{`; `{{name}}` is a placeholder; any other brace text passes through. */
const PLACEHOLDER = /\{\{\{\{|\{\{([A-Za-z0-9_]+)\}\}/g;

export type MapExpansion =
  | { readonly ok: true; readonly members: ReadonlyArray<SwarmMemberInput> }
  | { readonly ok: false; readonly message: string };

const fill = (
  template: string,
  row: SwarmMap["rows"][number],
  used: Set<string>,
  missing: Array<string>,
): string =>
  template.replace(PLACEHOLDER, (match, name: string | undefined) => {
    if (name === undefined) return "{{";
    if (name === "key") return row.key;
    const value = row.vars?.[name];
    if (value === undefined) {
      missing.push(name);
      return match;
    }
    used.add(name);
    return value;
  });

/** Expands a map to its members in row order, or names the first row that is invalid. */
export const expandSwarmMap = (map: SwarmMap): MapExpansion => {
  const { rows, task, title, doneCriteria, verify, ...settings } = map;
  const members: Array<SwarmMemberInput> = [];
  for (const row of rows) {
    const used = new Set<string>();
    const missing: Array<string> = [];
    const at = (template: string) => fill(template, row, used, missing);
    const member: SwarmMemberInput = {
      ...settings,
      key: row.key,
      title: at(title).trim(),
      task: at(task).trim(),
      ...(doneCriteria === undefined ? {} : { doneCriteria: at(doneCriteria) }),
      ...(verify === undefined
        ? {}
        : {
            verify: {
              ...verify,
              // Each argv element stays one element: no shell, no splitting.
              argv: [at(verify.argv[0]), ...verify.argv.slice(1).map(at)],
            },
          }),
      ...(row.ownsPaths === undefined ? {} : { ownsPaths: row.ownsPaths }),
    };
    if (missing.length > 0) {
      return {
        ok: false,
        message: `Map row '${row.key}' has no var '${missing[0]}' for placeholder {{${missing[0]}}}.`,
      };
    }
    const unused = Object.keys(row.vars ?? {}).filter((name) => !used.has(name));
    if (unused.length > 0) {
      return { ok: false, message: `Map row '${row.key}' sets unused var '${unused[0]}'.` };
    }
    if (member.task.length === 0 || member.task.length > TASK_MAX_CHARACTERS) {
      return {
        ok: false,
        message: `Map row '${row.key}' expands to a task of ${member.task.length} characters; it must be 1-${TASK_MAX_CHARACTERS}.`,
      };
    }
    if (member.title.length === 0 || member.title.length > TITLE_MAX_CHARACTERS) {
      return {
        ok: false,
        message: `Map row '${row.key}' expands to a title of ${member.title.length} characters; it must be 1-${TITLE_MAX_CHARACTERS}.`,
      };
    }
    members.push(member);
  }
  return { ok: true, members };
};
