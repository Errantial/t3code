import { assert, it } from "@effect/vitest";
import {
  CommandId,
  NodeId,
  ProviderInstanceId,
  RunId,
  SwarmId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { runMigrations } from "../persistence/Migrations.ts";
import * as SwarmStore from "./SwarmStore.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layerTest = Layer.merge(SwarmStore.layer.pipe(Layer.provide(database)), database);

const at = "2026-11-04T00:00:00.000Z";
const later = "2026-11-04T00:01:00.000Z";
const swarmId = SwarmId.make("swarm:round-trip");

const swarm: SwarmStore.SwarmRecord = {
  swarmId,
  requestKey: "request:round-trip",
  parentThreadId: ThreadId.make("thread:architect"),
  anchorRunId: RunId.make("run:anchor"),
  anchorNodeId: NodeId.make("node:anchor"),
  baseCommit: "abc123",
  title: "Round trip",
  wakePolicy: "batch",
  wakeBatchJson: '{"minCount":4}',
  maxConcurrent: 2,
  maxTotalTurns: null,
  verifyJson: '{"argv":["pnpm","test"]}',
  sharedContext: "shared",
  dataShape: null,
  allowSharedWriters: true,
  budgetExhausted: false,
  status: "active",
  createdAt: at,
  updatedAt: at,
};

it.layer(layerTest)("SwarmStore", (it) => {
  it.effect("round-trips swarms, members, notes, and pauses", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* SwarmStore.SwarmStore;
      yield* store.createSwarm({
        swarm,
        members: [
          { memberKey: "b", ordinal: 1, specJson: '{"task":"b"}', queuedAt: at },
          {
            memberKey: "a",
            ordinal: 0,
            specJson: '{"task":"a"}',
            queuedAt: at,
            writer: true,
            queueReason: "global_cap",
          },
        ],
      });

      assert.deepStrictEqual(yield* store.getSwarm(swarmId), Option.some(swarm));
      assert.deepStrictEqual(
        yield* store.getSwarmByRequestKey("request:round-trip"),
        Option.some(swarm),
      );
      assert.isTrue(Option.isNone(yield* store.getSwarm(SwarmId.make("swarm:missing"))));
      assert.deepStrictEqual(
        (yield* store.listSwarms({ statuses: ["active"], parentThreadId: swarm.parentThreadId }))
          .length,
        1,
      );
      assert.deepStrictEqual(yield* store.listSwarms({ statuses: ["completed"] }), []);

      const members = yield* store.listMembers(swarmId);
      assert.deepStrictEqual(
        members.map((member) => member.memberKey),
        ["a", "b"],
      );
      assert.deepInclude(members[0], {
        status: "queued",
        queueReason: "global_cap",
        attempt: 1,
        priority: 0,
        writer: true,
        released: false,
        followupNotified: false,
        supersededTaskId: null,
        lastFailedInstanceId: null,
        updatedAt: at,
      });

      const childThreadId = ThreadId.make("thread:member-a");
      assert.isTrue(
        yield* store.updateMember({
          swarmId,
          memberKey: "a",
          patch: {
            status: "running",
            queueReason: null,
            commandId: CommandId.make("command:member-a"),
            taskId: NodeId.make("node:member-a"),
            childThreadId,
            childRunId: RunId.make("run:member-a"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            effectiveRuntimeMode: "full-access",
            effectiveInteractionMode: "default",
            lastFailureClass: "transport_error",
            lastFailedAt: at,
            lastFailedInstanceId: ProviderInstanceId.make("codex"),
            followupNotified: true,
            released: true,
            startedAt: later,
            updatedAt: later,
          },
        }),
      );
      assert.isFalse(
        yield* store.updateMember({
          swarmId,
          memberKey: "missing",
          patch: { status: "failed", updatedAt: later },
        }),
      );
      const updated = Option.getOrThrow(yield* store.findMemberByChildThread(childThreadId));
      assert.deepInclude(updated, {
        memberKey: "a",
        status: "running",
        queueReason: null,
        effectiveRuntimeMode: "full-access",
        lastFailureClass: "transport_error",
        followupNotified: true,
        released: true,
        writer: true,
        startedAt: later,
        updatedAt: later,
      });

      yield* store.addMembers({
        swarmId,
        members: [{ memberKey: "c", ordinal: 2, specJson: "{}", queuedAt: later }],
        updatedAt: later,
      });
      assert.equal((yield* store.listMembers(swarmId)).length, 3);

      yield* store.updateSwarm(swarmId, {
        status: "completed",
        budgetExhausted: true,
        updatedAt: later,
      });
      assert.deepInclude(Option.getOrThrow(yield* store.getSwarm(swarmId)), {
        status: "completed",
        budgetExhausted: true,
        updatedAt: later,
      });

      yield* store.enqueueNote({
        swarmId,
        seq: 1,
        kind: "followup_result",
        membersJson: '[{"key":"a","followup":1}]',
        createdAt: at,
      });
      assert.deepStrictEqual(yield* store.listUnsentNotes, [
        {
          swarmId,
          seq: 1,
          kind: "followup_result",
          membersJson: '[{"key":"a","followup":1}]',
          sent: false,
          createdAt: at,
        },
      ]);
      yield* store.markNoteSent({ swarmId, seq: 1 });
      assert.deepStrictEqual(yield* store.listUnsentNotes, []);

      const instance = ProviderInstanceId.make("codex");
      yield* store.setInstancePause({
        providerInstanceId: instance,
        pauseClass: "usage_limit",
        until: later,
        at,
      });
      yield* store.setInstancePause({
        providerInstanceId: instance,
        pauseClass: "instance_down",
        until: later,
        at: later,
      });
      assert.deepStrictEqual(yield* store.listInstancePauses, [
        { providerInstanceId: instance, pauseClass: "instance_down", until: later, at: later },
      ]);
      yield* store.clearInstancePause(instance);
      assert.deepStrictEqual(yield* store.listInstancePauses, []);
    }),
  );

  it.effect("rolls back a swarm whose members cannot be written", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* SwarmStore.SwarmStore;
      const rolledBack = { ...swarm, swarmId: SwarmId.make("swarm:rollback"), requestKey: "r2" };
      const exit = yield* store
        .createSwarm({
          swarm: rolledBack,
          members: [
            { memberKey: "dup", ordinal: 0, specJson: "{}", queuedAt: at },
            { memberKey: "dup", ordinal: 1, specJson: "{}", queuedAt: at },
          ],
        })
        .pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
      assert.isTrue(Option.isNone(yield* store.getSwarm(rolledBack.swarmId)));
    }),
  );
});
