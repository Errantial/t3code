import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as ProviderOperationAdmission from "./ProviderOperationAdmission.ts";

const acquireAndRecord = (input: {
  readonly admission: ProviderOperationAdmission.ProviderOperationAdmission["Service"];
  readonly key: string;
  readonly limit: number;
  readonly operationId: string;
  readonly started: Deferred.Deferred<void>;
  readonly gate: Deferred.Deferred<void>;
}) =>
  Effect.gen(function* () {
    const lease = yield* input.admission.acquire({
      key: input.key,
      supportedConcurrency: input.limit,
      operationId: input.operationId,
      ownerKey: input.operationId,
    });
    yield* Deferred.succeed(input.started, undefined);
    yield* Deferred.await(input.gate).pipe(Effect.ensuring(lease.release));
  });

for (const limit of [1, 2, 4] as const) {
  it.effect(`admits exactly ${limit} provider operations before queueing`, () =>
    Effect.gen(function* () {
      const admission = yield* ProviderOperationAdmission.make;
      const gates = yield* Effect.forEach(Array.from({ length: limit + 2 }), () =>
        Deferred.make<void>(),
      );
      const started = yield* Effect.forEach(Array.from({ length: limit + 2 }), () =>
        Deferred.make<void>(),
      );
      const fibers = yield* Effect.forEach(gates, (gate, index) =>
        acquireAndRecord({
          admission,
          key: "driver:test",
          limit,
          operationId: `op-${index}`,
          started: started[index]!,
          gate,
        }).pipe(Effect.forkChild),
      );

      yield* Effect.forEach(started.slice(0, limit), Deferred.await, { discard: true });
      for (const queued of started.slice(limit)) {
        assert.isTrue(Option.isNone(yield* Deferred.poll(queued)));
      }

      yield* Deferred.succeed(gates[0]!, undefined);
      yield* Deferred.await(started[limit]!);
      assert.isTrue(Option.isNone(yield* Deferred.poll(started[limit + 1]!)));

      yield* Effect.forEach(gates, (gate) => Deferred.succeed(gate, undefined), { discard: true });
      yield* Effect.forEach(fibers, Fiber.join, { discard: true });
    }),
  );
}

it.effect("removes an interrupted queued operation without blocking the next waiter", () =>
  Effect.gen(function* () {
    const admission = yield* ProviderOperationAdmission.make;
    const first = yield* admission.acquire({
      key: "driver:test",
      supportedConcurrency: 1,
      operationId: "first",
      ownerKey: "first",
    });
    const second = yield* admission
      .acquire({
        key: "driver:test",
        supportedConcurrency: 1,
        operationId: "second",
        ownerKey: "second",
      })
      .pipe(Effect.forkChild);
    const third = yield* admission
      .acquire({
        key: "driver:test",
        supportedConcurrency: 1,
        operationId: "third",
        ownerKey: "third",
      })
      .pipe(Effect.forkChild);

    yield* Fiber.interrupt(second);
    yield* first.release;
    const thirdLease = yield* Fiber.join(third);
    yield* thirdLease.release;
  }),
);

it.effect("keeps admission keys independent", () =>
  Effect.gen(function* () {
    const admission = yield* ProviderOperationAdmission.make;
    const sameOwnerAcquired = yield* Deferred.make<void>();
    const first = yield* admission.acquire({
      key: "driver:first",
      supportedConcurrency: 1,
      operationId: "first",
      ownerKey: "first",
    });
    const second = yield* admission.acquire({
      key: "driver:second",
      supportedConcurrency: 1,
      operationId: "second",
      ownerKey: "second",
    });
    yield* first.release;
    yield* second.release;
  }),
);

it.effect("keeps one active operation per owner without head-of-line blocking other owners", () =>
  Effect.gen(function* () {
    const admission = yield* ProviderOperationAdmission.make;
    const sameOwnerAcquired = yield* Deferred.make<void>();
    const first = yield* admission.acquire({
      key: "driver:test",
      supportedConcurrency: 2,
      operationId: "owner-a-first",
      ownerKey: "owner-a",
    });
    const sameOwner = yield* admission
      .acquire({
        key: "driver:test",
        supportedConcurrency: 2,
        operationId: "owner-a-second",
        ownerKey: "owner-a",
      })
      .pipe(
        Effect.tap(() => Deferred.succeed(sameOwnerAcquired, undefined)),
        Effect.forkChild,
      );
    const otherOwner = yield* admission.acquire({
      key: "driver:test",
      supportedConcurrency: 2,
      operationId: "owner-b-first",
      ownerKey: "owner-b",
    });

    assert.isTrue(Option.isNone(yield* Deferred.poll(sameOwnerAcquired)));
    yield* otherOwner.release;
    assert.isTrue(Option.isNone(yield* Deferred.poll(sameOwnerAcquired)));
    yield* first.release;
    yield* Deferred.await(sameOwnerAcquired);
    const sameOwnerLease = yield* Fiber.join(sameOwner);
    yield* sameOwnerLease.release;
  }),
);

it.effect("release is idempotent", () =>
  Effect.gen(function* () {
    const admission = yield* ProviderOperationAdmission.make;
    const first = yield* admission.acquire({
      key: "driver:test",
      supportedConcurrency: 1,
      operationId: "first",
      ownerKey: "first",
    });
    yield* first.release;
    yield* first.release;
    const second = yield* admission.acquire({
      key: "driver:test",
      supportedConcurrency: 1,
      operationId: "second",
      ownerKey: "second",
    });
    yield* second.release;
  }),
);
