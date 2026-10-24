// Wake the MV3 worker as soon as a managed ChatGPT document starts loading.
//
// The ordinary recorder runs at document_idle because it needs the application DOM. A managed
// browser can be launched minimized/off-screen, though, and Chromium may defer document_idle long
// enough for the native provider readiness window to expire. This tiny isolated-world script has
// no page privileges and exists only to make worker startup deterministic on every cold launch.
try {
  const pending = chrome.runtime.sendMessage({ type: "native_provider_wake" });
  if (pending && typeof pending.catch === "function") pending.catch(() => undefined);
} catch {
  // The next managed navigation retries; a wake failure must never affect the page itself.
}
