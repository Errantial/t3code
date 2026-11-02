import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

export const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
const ORIGIN_IDENTITY_TIMEOUT = Duration.seconds(3);

/**
 * Which environment answers at an origin. A 200 alone does not prove the origin is this server:
 * a server started inside WSL is forwarded to the Windows host's loopback, so the same
 * `127.0.0.1:<port>` can reach another T3 environment.
 */
export type OriginIdentity =
  | { readonly kind: "same" }
  | { readonly kind: "other"; readonly environmentId: string }
  /** The origin did not answer with a readable descriptor; nothing is known either way. */
  | { readonly kind: "unknown" };

export const environmentIdFromDescriptor = (body: unknown): string | null =>
  typeof body === "object" &&
  body !== null &&
  "environmentId" in body &&
  typeof body.environmentId === "string" &&
  body.environmentId.length > 0
    ? body.environmentId
    : null;

export const compareOriginIdentity = (
  answeredEnvironmentId: string | null,
  expectedEnvironmentId: string,
): OriginIdentity =>
  answeredEnvironmentId === null
    ? { kind: "unknown" }
    : answeredEnvironmentId === expectedEnvironmentId
      ? { kind: "same" }
      : { kind: "other", environmentId: answeredEnvironmentId };

/** Reads only `environmentId` from the descriptor an origin serves; never fails. */
export const readOriginEnvironmentId = (
  httpClient: HttpClient.HttpClient,
  origin: string,
): Effect.Effect<string | null> =>
  httpClient.get(`${origin.replace(/\/+$/, "")}${ENVIRONMENT_DESCRIPTOR_PATH}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? response.json : Effect.succeed(null as unknown),
    ),
    Effect.map(environmentIdFromDescriptor),
    Effect.scoped,
    Effect.timeoutOption(ORIGIN_IDENTITY_TIMEOUT),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
