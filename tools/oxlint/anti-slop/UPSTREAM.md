# Anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b
- Source path: skills/install-anti-slop/assets/anti-slop/
- Installed path: tools/oxlint/anti-slop/
- Changes to vendored implementation: none.
- Root LICENSE copied from the same commit; nested Stylistic LICENSE and UPSTREAM.md preserved.
- Generic rules are enabled. Effect rules require a direct Effect dependency.

## Integration verification

- pnpm 12.3.1 retained; `oxlint` and `@oxlint/plugins` pinned to 1.86.0.
- All 18 generic rules and native `oxc/no-accumulating-spread` enabled at error.
- Existing Worker/web generated-file ignores and CI/security settings retained.
- Worker test sources now typechecked alongside production source.
- Existing native lint warnings are reported, not disabled by this rollout.
- The one narrow rule exception is `shouldRetryGeminiError(error: unknown)`:
  JavaScript promise rejections can be arbitrary values; its offline regression
  test verifies primitive/object rejections and provider-specific retry decisions.
- Validation: frozen install, lint, TypeScript (including Worker tests), offline
  Worker/web tests, format checks, Worker bundle and Next/OpenNext builds plus
  deployment dry-runs. Nested configuration negative probe confirms loading.
- Offline actual workerd/Agent smoke covers construction, initial state/startup,
  idle WebSocket protocol, reconnect, and forged client-state rejection.
- No real provider, device, clinical inference, patient-data, or deployment tests.
- Canonical vendor sources/licenses and original reference content are preserved.
