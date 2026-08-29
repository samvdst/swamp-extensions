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

Requires an installed Omarchy system (`omarchy` CLI on `PATH`) and `pacman`.

MIT licensed.
