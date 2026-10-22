# Meterless Markovian engine — vendored reference implementation

The files in `src/` are the Meterless Markovian engine's TypeScript reference
implementation, copied **unmodified** from the upstream repository. Evidence Desk
uses this engine to run each investigation: its injected generator, bounded
chunks, `[STATE_CHECKPOINT]` carryover and compression cascade, run history, and
progress events.

| | |
|---|---|
| Upstream | https://github.com/Meterless/Meterless |
| Path | `engines/markovian/reference/src/` |
| Pinned commit | `1742dec56a66e58eef9dda2d2b865823758ca8cd` (2026-10-19) |
| Last commit touching that path | `85c5d41493c6ae2ceb06ad76144932309cfda3dd` |
| Upstream package | `@meterless/markovian-reference@0.1.0` (`private: true`, not published to npm) |
| License | Apache License 2.0, see `LICENSE` (copied from `engines/markovian/LICENSE`) |
| Copyright | The Meterless authors |

It is vendored because the upstream package is private and has no published npm
release. The upstream test file (`reference/test/smoke.test.ts`) uses vitest and
is not copied. Evidence Desk's own tests exercise the engine through its public
`Markovian` class.

The sources import each other with `.ts` extensions. The root `tsconfig.json`
compiles them with `rewriteRelativeImportExtensions`, so no source edits are
needed.

## SHA-256 of the vendored files

```
ebc46290b8122876f6feac4722dc7f31bc487ac90fdbbe4c724ca156e8b0dc74  carryover.ts
4ee7e24c3e8ce0d80bcd708ff3a05c2fb2c927950288d8bef58da10e07a13086  configManager.ts
dd6559d6a03d83e0fb37436fc74919a1d15721721dbe6d04e5783cf5e4a64e71  history.ts
c7219b3ca33b98fe1a8ee646c58558f2c6c40443cdfc8615f69fdf0f96a082b5  index.ts
2a134726c88654670a5fe286a197601b24a41d18f8333f21ac1268c7ccebe499  markers.ts
372871ab125d766cf390c29b37130d0ce01d53af8aa9b8f4407ae7785fc8f84a  orchestrator.ts
391d098ccab56c49dbf2b11329b7992c0e30cda13089385126e965c6990dc8d0  progress.ts
db72c77751b170f32beae7482b5ab7b24d81379e0df5d3fbfaae30b08a075228  promptBuilder.ts
cee012ae1d3ff8e6bc23de40788bc56c6f83948ccc57084354f0803e5bd2755d  types.ts
```

To update: copy the newer `reference/src/*.ts` over these files, update the
commit and hashes above, and run `npm test`.
