// Vitest test-isolation: scrub CTX_* environment variables before each test file.
//
// cortextOS agents run with CTX_AGENT_DIR / CTX_PROJECT_ROOT / CTX_FRAMEWORK_ROOT /
// CTX_ORG / CTX_AGENT_NAME / CTX_ROOT / CTX_INSTANCE_ID exported. If `npm test` is run
// from INSIDE an agent session, those leak into the CLI/daemon subprocesses the tests
// spawn — tripping the sandbox-leak guard ("CTX_AGENT_DIR not under CTX_FRAMEWORK_ROOT")
// and making tests read live state instead of their temp fixtures. ~33 tests that pass
// cleanly in CI fail this way. Deleting CTX_* here (per worker, before tests) makes the
// suite independent of the caller's environment. Tests that need CTX_* set their own
// values explicitly, which run after this scrub and are therefore unaffected.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
