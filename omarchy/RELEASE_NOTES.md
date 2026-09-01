# Release Notes

## 2026.08.30.1

Add `@samvdst/omarchy/direct-package` with tracked direct-download package
`sync`, `install`, `update`, `replace`, and `delete` methods for native Arch
`.pkg.tar.zst` artifacts.
Add a serial bulk-operation workflow and versioned provenance/operation logs.

## 2026.08.29.1

Initial release. Model type `@samvdst/omarchy/machine` with `sync`, `update`,
`theme`, `pkg`, and `toggle` methods, an `omarchy-present` pre-flight check,
and versioned `state`/`packages`/`toggles` resources plus an `updateLog` file.
