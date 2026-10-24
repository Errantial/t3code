import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface ProviderOperationAdmissionLease {
  readonly release: Effect.Effect<void>;
}

interface Waiter {
  readonly operationId: string;
  readonly ownerKey: string;
  readonly ready: Deferred.Deferred<void>;
}

interface AdmissionBucket {
  readonly limit: number;
  readonly active: ReadonlyMap<string, string>;
  readonly waiting: ReadonlyArray<Waiter>;
}

interface AdmissionState {
  readonly buckets: ReadonlyMap<string, AdmissionBucket>;
}

const emptyState: AdmissionState = { buckets: new Map() };

const dispatch = (bucket: AdmissionBucket): readonly [AdmissionBucket, ReadonlyArray<Waiter>] => {
  const active = new Map(bucket.active);
  const waiting = [...bucket.waiting];
  const admitted: Array<Waiter> = [];
  while (active.size < bucket.limit) {
    const activeOwners = new Set(active.values());
    const index = waiting.findIndex((waiter) => !activeOwners.has(waiter.ownerKey));
    if (index < 0) break;
    const [waiter] = waiting.splice(index, 1);
    if (waiter === undefined) break;
    active.set(waiter.operationId, waiter.ownerKey);
    admitted.push(waiter);
  }
  return [{ ...bucket, active, waiting }, admitted];
};

export class ProviderOperationAdmission extends Context.Service<
  ProviderOperationAdmission,
  {
    readonly acquire: (input: {
      readonly key: string;
      readonly supportedConcurrency: number;
      readonly operationId: string;
      readonly ownerKey: string;
    }) => Effect.Effect<ProviderOperationAdmissionLease>;
  }
>()("t3/orchestration-v2/ProviderOperationAdmission") {}

export const make = Effect.gen(function* () {
  const state = yield* Ref.make(emptyState);

  const releaseOperation = (key: string, operationId: string) =>
    Ref.modify(state, (current) => {
      const bucket = current.buckets.get(key);
      if (bucket === undefined || !bucket.active.has(operationId)) {
        return [[], current] as const;
      }
      const active = new Map(bucket.active);
      active.delete(operationId);
      const [nextBucket, admitted] = dispatch({ ...bucket, active });
      const buckets = new Map(current.buckets);
      buckets.set(key, nextBucket);
      return [admitted, { buckets }] as const;
    }).pipe(
      Effect.flatMap((admitted) =>
        Effect.forEach(admitted, (waiter) => Deferred.succeed(waiter.ready, undefined), {
          discard: true,
        }),
      ),
    );

  const cancelWaiter = (key: string, operationId: string) =>
    Ref.modify(state, (current) => {
      const bucket = current.buckets.get(key);
      if (bucket === undefined) return [false, current] as const;
      const waiting = bucket.waiting.filter((waiter) => waiter.operationId !== operationId);
      if (waiting.length === bucket.waiting.length) return [false, current] as const;
      const buckets = new Map(current.buckets);
      buckets.set(key, { ...bucket, waiting });
      return [true, { buckets }] as const;
    }).pipe(
      Effect.flatMap((removed) => (removed ? Effect.void : releaseOperation(key, operationId))),
    );

  const acquire: ProviderOperationAdmission["Service"]["acquire"] = Effect.fn(
    "ProviderOperationAdmission.acquire",
  )((input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const limit = Math.max(1, Math.floor(input.supportedConcurrency));
        const ready = yield* Deferred.make<void>();
        const admission = yield* Ref.modify(state, (current) => {
          const existing = current.buckets.get(input.key);
          const bucket = existing ?? {
            limit,
            active: new Map<string, string>(),
            waiting: [],
          };
          if (bucket.active.has(input.operationId)) {
            return [
              { admitted: true, newlyAdmitted: [] as ReadonlyArray<Waiter> },
              current,
            ] as const;
          }
          const ownerActive = Array.from(bucket.active.values()).includes(input.ownerKey);
          if (bucket.active.size < bucket.limit && bucket.waiting.length === 0 && !ownerActive) {
            const buckets = new Map(current.buckets);
            buckets.set(input.key, {
              ...bucket,
              active: new Map(bucket.active).set(input.operationId, input.ownerKey),
            });
            return [
              { admitted: true, newlyAdmitted: [] as ReadonlyArray<Waiter> },
              { buckets },
            ] as const;
          }
          const buckets = new Map(current.buckets);
          const [nextBucket, newlyAdmitted] = dispatch({
            ...bucket,
            waiting: [
              ...bucket.waiting,
              { operationId: input.operationId, ownerKey: input.ownerKey, ready },
            ],
          });
          buckets.set(input.key, nextBucket);
          return [
            {
              admitted: nextBucket.active.has(input.operationId),
              newlyAdmitted,
            },
            { buckets },
          ] as const;
        });
        yield* Effect.forEach(
          admission.newlyAdmitted.filter((waiter) => waiter.operationId !== input.operationId),
          (waiter) => Deferred.succeed(waiter.ready, undefined),
          { discard: true },
        );
        if (!admission.admitted) {
          yield* restore(Deferred.await(ready)).pipe(
            Effect.onInterrupt(() => cancelWaiter(input.key, input.operationId)),
          );
        }
        let released = false;
        return {
          release: Effect.suspend(() => {
            if (released) return Effect.void;
            released = true;
            return releaseOperation(input.key, input.operationId);
          }),
        };
      }),
    ),
  );

  return ProviderOperationAdmission.of({ acquire });
});

export const layer = Layer.effect(ProviderOperationAdmission, make);
