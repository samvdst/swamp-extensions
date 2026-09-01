# @samvdst/omarchy

Manage [Omarchy](https://omarchy.org/) Linux machines through swamp:
versioned state snapshots for drift detection, plus updates, themes,
packages, and feature toggles as typed model methods.

## Model type: `@samvdst/omarchy/machine`

One instance per machine. Resources: `state` (version, channel, theme, font,
update availability), `packages` (installed inventory), `toggles`, and an
`updateLog` file per update run.

| Method   | What it does                                                          |
| -------- | --------------------------------------------------------------------- |
| `sync`   | Snapshot state and package inventory                                   |
| `update` | Run `omarchy update -y`, persist the log (also on failure), re-snapshot |
| `theme`  | Apply a theme by name, re-snapshot                                     |
| `pkg`    | Fan-out `add`/`aurAdd`/`drop` lists in one call, refresh inventory     |
| `toggle` | Flip a feature flag and record the resulting state                     |

A `live`-labeled pre-flight check verifies the `omarchy` CLI responds before
any mutating method runs.

## Usage

```bash
swamp extension pull @samvdst/omarchy
swamp model create @samvdst/omarchy/machine mylaptop
swamp model @samvdst/omarchy/machine method run sync mylaptop
swamp model @samvdst/omarchy/machine method run theme mylaptop --input name=Nord
```

## Model type: `@samvdst/omarchy/direct-package`

One persistent model per package downloaded outside Arch repositories. The
`sync`, `install`, `update`, `replace`, and `delete` methods inspect the
artifact, use pacman for file ownership and removal, and write versioned
`state` plus an `operationLog`. Sources may be HTTPS URLs or absolute local
paths and must be native `.pkg.tar.zst` Arch packages.

```bash
swamp model create @samvdst/omarchy/direct-package my-app \
  --global-arg packageName=my-app \
  --global-arg source=https://downloads.example.com/my-app-1.2.3-1-x86_64.pkg.tar.zst
swamp model method run my-app install
swamp model method run my-app sync
```

Change the model's source with `swamp model edit grok-bot`, then run `update`
for a newer version or `replace` to force the configured artifact.
Inspect all tracked direct packages through the datastore:

```bash
swamp data query \
  'modelType == "@samvdst/omarchy/direct-package" && specName == "state"' \
  --select '{"package": modelName, "version": attributes.installedVersion, "status": attributes.status}'
```

The bundled `@samvdst/omarchy/direct-packages` workflow runs one action across
multiple package models, serially to avoid pacman's global lock:

```bash
swamp workflow run @samvdst/omarchy/direct-packages \
  --input action=update --input 'packages=["grok-bot"]'
```

Requires an installed Omarchy system (`omarchy` CLI on `PATH`) and `pacman`.
Downloaded artifacts are temporary; swamp stores their URL, metadata, SHA-256,
action history, and logs rather than duplicating large binaries in its
datastore.

MIT licensed.
