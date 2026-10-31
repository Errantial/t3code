import { assert, describe, it } from "@effect/vitest";

import {
  HIDDEN_LAUNCHER_FILE_NAME,
  planHiddenLauncher,
  renderHiddenLauncher,
  vbsStringLiteral,
} from "./remoteRuntimeSyncMigration.ts";

describe("planHiddenLauncher", () => {
  it("wraps the PowerShell task the Framework created", () => {
    const plan = planHiddenLauncher({
      execute: "powershell.exe",
      arguments:
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Users\\Emil\\apps\\t3code-service\\remote-runtime-sync.ps1",
    });
    assert.deepEqual(plan, {
      scriptPath: "C:\\Users\\Emil\\apps\\t3code-service\\remote-runtime-sync.ps1",
      commandLine:
        '"powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Users\\Emil\\apps\\t3code-service\\remote-runtime-sync.ps1',
      launcherPath: `C:\\Users\\Emil\\apps\\t3code-service\\${HIDDEN_LAUNCHER_FILE_NAME}`,
    });
  });

  it("wraps the .cmd task the laptop created", () => {
    const plan = planHiddenLauncher({ execute: "C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd" });
    assert.equal(plan?.commandLine, 'cmd.exe /d /s /c ""C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd""');
    assert.equal(plan?.launcherPath, `C:\\Users\\emilg\\.t3\\${HIDDEN_LAUNCHER_FILE_NAME}`);
  });

  it("keeps .cmd arguments when the task carries them", () => {
    const plan = planHiddenLauncher({
      execute: "C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd",
      arguments: "--once",
    });
    assert.equal(plan?.commandLine, 'cmd.exe /d /s /c ""C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd" --once"');
  });

  it("recognises a command run through cmd.exe", () => {
    const plan = planHiddenLauncher({
      execute: "cmd.exe",
      arguments: '/d /c "C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd"',
    });
    assert.equal(plan?.scriptPath, "C:\\Users\\emilg\\.t3\\remote-runtime-sync.cmd");
  });

  it("leaves an already hidden task and unknown shapes alone", () => {
    assert.equal(planHiddenLauncher({ execute: "wscript.exe", arguments: '//B "x.vbs"' }), null);
    assert.equal(planHiddenLauncher({ execute: "C:\\tools\\sync.exe" }), null);
    assert.equal(planHiddenLauncher({ execute: "powershell.exe", arguments: "-NoProfile" }), null);
    assert.equal(planHiddenLauncher({ execute: "powershell.exe", arguments: "-File relative.ps1" }), null);
  });
});

describe("renderHiddenLauncher", () => {
  it("runs the command hidden and does not wait", () => {
    const plan = planHiddenLauncher({
      execute: "powershell.exe",
      arguments: "-File C:\\sync.ps1",
    });
    const text = renderHiddenLauncher(plan!);
    assert.include(text, 'CreateObject("WScript.Shell")');
    assert.include(
      text,
      `shell.Run ${vbsStringLiteral('"powershell.exe" -File C:\\sync.ps1')}, 0, False`,
    );
  });

  it("doubles quotes inside the VBS string literal", () => {
    assert.equal(vbsStringLiteral('say "hi"'), '"say ""hi"""');
  });
});
