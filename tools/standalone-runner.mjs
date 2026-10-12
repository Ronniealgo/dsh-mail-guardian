// Compatibility entry: the v2 CLI is cache-first and has a bounded sync path.
process.argv[2] = process.argv[2] ?? "sync";
await import("../bin/mail-guardian.mjs");
