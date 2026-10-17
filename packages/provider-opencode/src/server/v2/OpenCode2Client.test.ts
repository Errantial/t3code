import { assert, it } from "@effect/vitest";
import { Session, Skill } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_BODY = '{"version":"2.0.18","pid":4242,"urls":[],"paths":{"tmp":"/tmp"}}';

const authorizationFor = (password: string | Redacted.Redacted) => {
  const seen: Array<string | undefined> = [];
  const layerCapturing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(INFO_BODY, { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password });
    yield* client.server.info();
    return seen[0];
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
};

const utf8Basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

describe("OpenCode2Client authorization", () => {
  // OpenCode decodes Basic credentials as UTF-8. Latin-1 (`btoa`) encoding gets
  // `pässwörd` rejected with a 401 and throws on characters such as `€`.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
  );
});

describe("OpenCode2Client prompt transport", () => {
  it.effect(
    "carries a 16 KiB Civilization packet plus bounded user text through the pinned prompt client",
    () => {
      const packet = "P".repeat(16 * 1024);
      const attachmentMetadata =
        '[Attached file "spec.pdf" is saved at: /attachments/file-document.pdf]';
      const text = `${packet}\n\n$plum user text\n\n${attachmentMetadata}`;
      const seen: Array<unknown> = [];
      const layerCapturing = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
            seen.push(JSON.parse(new TextDecoder().decode(request.body.body)));
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  data: {
                    id: "msg_0eb735d41001NJee1EvVePJAK5",
                    sessionID: "ses_f148ca2deffeJcwCnRQtb0YFNX",
                    time: { created: 1790656601410 },
                    type: "user",
                    payload: { text },
                    delivery: "steer",
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }),
        ),
      );

      return Effect.gen(function* () {
        const opencode = yield* OpenCode2Client.OpenCode2Client;
        const { client } = yield* opencode.connect({
          baseUrl: "http://127.0.0.1:4096",
          password: "secret",
        });
        const response = yield* client.session.prompt({
          sessionID: Session.ID.make("ses_f148ca2deffeJcwCnRQtb0YFNX"),
          text,
          skills: [{ id: Skill.ID.make("plum") }],
          resume: false,
        });

        assert.lengthOf(seen, 1);
        assert.deepInclude(seen[0] as object, {
          text,
          skills: [{ id: "plum" }],
          resume: false,
        });
        assert.include(text, attachmentMetadata);
        assert.equal(response.payload.text, text);
      }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
    },
  );
});
