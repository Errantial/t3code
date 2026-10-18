import { describe, expect, it } from "vite-plus/test";

import {
  parseCivilizationHistoricalContextSearch,
  validateCivilizationSettingsSearch,
} from "./settings.civilization";

describe("Civilization Settings deep-link search", () => {
  it.each(["overview", "citizens", "activity", "context", "configuration"] as const)(
    "keeps the %s view",
    (view) => {
      expect(validateCivilizationSettingsSearch({ view })).toEqual({ view });
    },
  );

  it("keeps only modes and focus identifiers owned by the active view", () => {
    expect(
      validateCivilizationSettingsSearch({
        view: "citizens",
        citizen: " citizen-a ",
        lineage: " lineage-a ",
        activity: "messages",
        activityThread: "thread-ignored",
        contextMode: "inspector",
      }),
    ).toEqual({
      view: "citizens",
      citizen: "citizen-a",
      lineage: "lineage-a",
    });

    expect(
      validateCivilizationSettingsSearch({
        view: "activity",
        activity: "chronicle",
        activityThread: " thread-a ",
        activitySource: " source-a ",
        activityMessage: "message-ignored",
        activityNote: "note-ignored",
      }),
    ).toEqual({
      view: "activity",
      activity: "chronicle",
      activityThread: "thread-a",
      activitySource: "source-a",
    });

    expect(
      validateCivilizationSettingsSearch({
        view: "activity",
        activity: "messages",
        activityThread: " participant-a ",
        activityMessage: " message-a ",
      }),
    ).toEqual({
      view: "activity",
      activity: "messages",
      activityThread: "participant-a",
      activityMessage: "message-a",
    });

    expect(
      validateCivilizationSettingsSearch({
        view: "activity",
        activity: "notes",
        activityNote: " note-a ",
      }),
    ).toEqual({ view: "activity", activity: "notes" });

    expect(
      validateCivilizationSettingsSearch({
        view: "context",
        contextMode: "inspector",
        citizen: "citizen-ignored",
        contextFilterThread: " thread-a ",
        contextFilterProvider: " provider-a ",
        contextFilterOutcome: "provider_start_accepted",
        contextFilterSuppression: "provider_unsupported",
        contextFilterFrom: " 2026-10-18T10:00:00.000Z ",
        contextFilterTo: " 2026-10-18T11:00:00.000Z ",
      }),
    ).toEqual({
      view: "context",
      contextMode: "inspector",
      contextFilterThread: "thread-a",
      contextFilterProvider: "provider-a",
      contextFilterOutcome: "provider_start_accepted",
      contextFilterSuppression: "provider_unsupported",
      contextFilterFrom: "2026-10-18T10:00:00.000Z",
      contextFilterTo: "2026-10-18T11:00:00.000Z",
    });
  });

  it("drops invalid Inspector metadata filters rather than broadening them into different values", () => {
    expect(
      validateCivilizationSettingsSearch({
        view: "context",
        contextMode: "inspector",
        contextFilterOutcome: "accepted",
        contextFilterSuppression: "unknown_reason",
      }),
    ).toEqual({ view: "context", contextMode: "inspector" });
  });

  it("drops unknown view and mode values", () => {
    expect(
      validateCivilizationSettingsSearch({
        view: "unknown",
        activity: "messages",
        contextMode: "inspector",
        citizen: "citizen-a",
      }),
    ).toEqual({});
    expect(validateCivilizationSettingsSearch({ view: "activity", activity: "mail" })).toEqual({
      view: "activity",
    });
    expect(validateCivilizationSettingsSearch({ view: "context", contextMode: "history" })).toEqual(
      { view: "context" },
    );
  });

  it("keeps only valid exact historical turn identifiers", () => {
    expect(
      validateCivilizationSettingsSearch({
        contextThread: " thread-a ",
        contextRun: " run-a ",
        contextAttempt: " attempt-a ",
        contextTurn: "3",
        packetText: "must-not-pass",
      }),
    ).toEqual({
      contextThread: "thread-a",
      contextRun: "run-a",
      contextAttempt: "attempt-a",
      contextTurn: 3,
    });
  });

  it("drops an incomplete or malformed historical tuple as a unit", () => {
    expect(
      validateCivilizationSettingsSearch({
        view: "context",
        contextMode: "inspector",
        contextThread: "thread-a",
        contextRun: "run-a",
        contextAttempt: "attempt-a",
      }),
    ).toEqual({ view: "context", contextMode: "inspector" });
    expect(
      validateCivilizationSettingsSearch({
        contextThread: "thread-a",
        contextRun: "run-a",
        contextAttempt: "attempt-a",
        contextTurn: "3.5",
      }),
    ).toEqual({});
    expect(
      parseCivilizationHistoricalContextSearch({
        contextThread: "thread-a",
        contextRun: "run-a",
        contextAttempt: "attempt-a",
        contextTurn: "3",
      }),
    ).toEqual({
      contextThread: "thread-a",
      contextRun: "run-a",
      contextAttempt: "attempt-a",
      contextTurn: 3,
    });
  });
});
