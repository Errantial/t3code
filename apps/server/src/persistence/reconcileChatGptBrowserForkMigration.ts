import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadMessageSearch from "./Migrations/069_ThreadMessageSearch.ts";
import PeerLinks from "./Migrations/070_PeerLinks.ts";
import PeerLinkFence from "./Migrations/071_PeerLinkFence.ts";
import WaitingLinkRequestIndex from "./Migrations/072_WaitingLinkRequestIndex.ts";

// The ChatGPT Browser fork shipped its provider-operations migration as 69
// before main used that id. A database written by that build recorded 69 under
// the fork's name, so main's 69-72 and the fork's own migration need their ids
// translated once before the migrator's history check runs.
export const reconcileChatGptBrowserForkMigration = Effect.fn(
  "reconcileChatGptBrowserForkMigration",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 69
      `;
      const legacy = history.find(
        (row) => row.migration_id === 69 && row.name === "ChatGptBrowserProviderOperations",
      );
      if (!legacy) return [];
      const later = history.filter((row) => row.migration_id !== 69);
      if (later.length > 0) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message:
            "Cannot upgrade a ChatGPT Browser fork database that recorded migrations after its provider-operations migration.",
        });
      }
      yield* ThreadMessageSearch;
      yield* PeerLinks;
      yield* PeerLinkFence;
      yield* WaitingLinkRequestIndex;
      // Move the fork's record past main's new ids first to avoid a key collision.
      yield* sql`
        UPDATE effect_sql_migrations
        SET migration_id = 73
        WHERE migration_id = 69 AND name = 'ChatGptBrowserProviderOperations'
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (69, 'ThreadMessageSearch'),
          (70, 'PeerLinks'),
          (71, 'PeerLinkFence'),
          (72, 'WaitingLinkRequestIndex')
      `;
      return [
        [69, "ThreadMessageSearch"],
        [70, "PeerLinks"],
        [71, "PeerLinkFence"],
        [72, "WaitingLinkRequestIndex"],
        [73, "ChatGptBrowserProviderOperations"],
      ] as const;
    }),
  );
});
