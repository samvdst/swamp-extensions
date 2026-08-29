/**
 * Manages an Omarchy Linux machine: captures versioned system state
 * (version, channel, theme, packages) for drift detection, and drives
 * updates, theme changes, package installs, and feature toggles through
 * the `omarchy` CLI.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({});

const StateSchema = z.object({
  version: z.string(),
  channel: z.string(),
  theme: z.string(),
  background: z.string(),
  font: z.string(),
  updateAvailable: z.boolean(),
  updateMessage: z.string(),
  syncedAt: z.string(),
});

const PackagesSchema = z.object({
  installed: z.array(z.string()),
  count: z.number(),
  syncedAt: z.string(),
});

const ToggleSchema = z.object({
  flag: z.string(),
  enabled: z.boolean(),
  changedAt: z.string(),
});

interface RunResult {
  ok: boolean;
  code: number;
  output: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Output goes to a temp file, not pipes: omarchy commands can spawn daemons
// (hyprsunset, shell restarts) that inherit stdout and never close it, which
// hangs piped readers forever. A file descriptor has no EOF to wait on.
async function run(bin: string, args: string[]): Promise<RunResult> {
  const logFile = await Deno.makeTempFile({ prefix: "omarchy-model-" });
  try {
    const command = [bin, ...args].map(shellQuote).join(" ");
    const status = await new Deno.Command("bash", {
      args: ["-c", `${command} </dev/null &>${shellQuote(logFile)}`],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    const output = (await Deno.readTextFile(logFile)).trim();
    return { ok: status.success, code: status.code, output };
  } finally {
    await Deno.remove(logFile).catch(() => {});
  }
}

/** Seam for unit tests to stub command execution. */
export const _internals = { run };

async function omarchy(...args: string[]): Promise<string> {
  const result = await _internals.run("omarchy", args);
  if (!result.ok) {
    throw new Error(
      `omarchy ${
        args.join(" ")
      } failed (exit ${result.code}): ${result.output}`,
    );
  }
  return result.output;
}

async function captureState(): Promise<z.infer<typeof StateSchema>> {
  const [version, channel, theme, background, font] = await Promise.all([
    omarchy("version"),
    omarchy("channel", "current"),
    omarchy("theme", "current"),
    omarchy("theme", "bg", "current"),
    omarchy("font", "current"),
  ]);
  const update = await _internals.run("omarchy", ["update", "available"]);
  return {
    version,
    channel,
    theme,
    background,
    font,
    updateAvailable: update.ok,
    updateMessage: update.output,
    syncedAt: new Date().toISOString(),
  };
}

async function capturePackages(): Promise<z.infer<typeof PackagesSchema>> {
  const result = await _internals.run("pacman", ["-Qq"]);
  if (!result.ok) {
    throw new Error(`pacman -Qq failed: ${result.output}`);
  }
  const installed = result.output.split("\n").filter(Boolean);
  return {
    installed,
    count: installed.length,
    syncedAt: new Date().toISOString(),
  };
}

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type Logger = {
  info(msg: string, props?: Record<string, unknown>): void;
};

async function writeSnapshot(
  writeResource: WriteResource,
): Promise<Array<{ name: string }>> {
  const [state, packages] = await Promise.all([
    captureState(),
    capturePackages(),
  ]);
  return [
    await writeResource("state", "state", state),
    await writeResource("packages", "packages", packages),
  ];
}

/** Model definition for managing an Omarchy Linux machine. */
export const model = {
  type: "@samvdst/omarchy/machine",
  version: "2026.08.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "state": {
      description: "Omarchy system state snapshot",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    "packages": {
      description: "Installed package inventory",
      schema: PackagesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "toggles": {
      description: "Omarchy feature toggle states",
      schema: ToggleSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    "updateLog": {
      description: "Output of omarchy update runs",
      contentType: "text/plain",
      lifetime: "1mo",
      garbageCollection: 5,
    },
  },
  checks: {
    "omarchy-present": {
      description: "Ensure the omarchy CLI is installed and responding",
      labels: ["live"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> => {
        const result = await _internals.run("omarchy", ["version"]);
        return result.ok ? { pass: true } : {
          pass: false,
          errors: [`omarchy CLI not available: ${result.output}`],
        };
      },
    },
  },
  methods: {
    sync: {
      description:
        "Capture a full system state snapshot (version, channel, theme, font, update availability, package inventory)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: { logger: Logger; writeResource: WriteResource },
      ) => {
        context.logger.info("Capturing system state snapshot");
        const handles = await writeSnapshot(context.writeResource);
        context.logger.info("Snapshot captured");
        return { dataHandles: handles };
      },
    },
    update: {
      description:
        "Run a full omarchy system update, persist the log, and re-snapshot state",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: {
          logger: Logger;
          writeResource: WriteResource;
          createFileWriter: (
            specName: string,
            name: string,
          ) => { writeText(text: string): Promise<{ name: string }> };
        },
      ) => {
        const before = await omarchy("version");
        context.logger.info("Updating omarchy from {before}", { before });
        const result = await _internals.run("omarchy", ["update", "-y"]);
        const logHandle = await context.createFileWriter(
          "updateLog",
          "updateLog",
        )
          .writeText(result.output);
        if (!result.ok) {
          throw new Error(
            `omarchy update failed (exit ${result.code}) - see updateLog file`,
          );
        }
        const handles = await writeSnapshot(context.writeResource);
        context.logger.info("Update complete");
        return { dataHandles: [logHandle, ...handles] };
      },
    },
    theme: {
      description: "Apply an Omarchy theme and re-snapshot state",
      arguments: z.object({
        name: z.string().describe("Theme name as shown by omarchy theme list"),
      }),
      execute: async (
        args: { name: string },
        context: { logger: Logger; writeResource: WriteResource },
      ) => {
        context.logger.info("Applying theme {name}", { name: args.name });
        await omarchy("theme", "set", args.name);
        const handles = await writeSnapshot(context.writeResource);
        context.logger.info("Theme applied: {name}", { name: args.name });
        return { dataHandles: handles };
      },
    },
    pkg: {
      description:
        "Install and remove packages in one fan-out operation, then refresh the package inventory",
      arguments: z.object({
        add: z.array(z.string()).default([]).describe(
          "Arch packages to install",
        ),
        aurAdd: z.array(z.string()).default([]).describe(
          "AUR packages to install",
        ),
        drop: z.array(z.string()).default([]).describe("Packages to remove"),
      }),
      execute: async (
        args: { add: string[]; aurAdd: string[]; drop: string[] },
        context: { logger: Logger; writeResource: WriteResource },
      ) => {
        if (!args.add.length && !args.aurAdd.length && !args.drop.length) {
          throw new Error("Provide at least one of: add, aurAdd, drop");
        }
        context.logger.info(
          "Managing packages: {add} to add, {aurAdd} from AUR, {drop} to drop",
          {
            add: args.add.length,
            aurAdd: args.aurAdd.length,
            drop: args.drop.length,
          },
        );
        if (args.add.length) await omarchy("pkg", "add", ...args.add);
        if (args.aurAdd.length) {
          await omarchy("pkg", "aur", "add", ...args.aurAdd);
        }
        if (args.drop.length) await omarchy("pkg", "drop", ...args.drop);
        const wanted = [...args.add, ...args.aurAdd];
        if (wanted.length) await omarchy("pkg", "present", ...wanted);
        const packages = await capturePackages();
        const handle = await context.writeResource(
          "packages",
          "packages",
          packages,
        );
        context.logger.info("Package inventory refreshed: {count} installed", {
          count: packages.count,
        });
        return { dataHandles: [handle] };
      },
    },
    toggle: {
      description: "Toggle an Omarchy feature flag and record its state",
      arguments: z.object({
        flag: z.string().describe(
          "Flag name, e.g. nightlight, idle, screensaver",
        ),
        state: z.enum(["on", "off", "toggle"]).default("toggle"),
      }),
      execute: async (
        args: { flag: string; state: "on" | "off" | "toggle" },
        context: { logger: Logger; writeResource: WriteResource },
      ) => {
        context.logger.info("Setting toggle {flag} to {state}", {
          flag: args.flag,
          state: args.state,
        });
        await omarchy("toggle", args.flag, args.state);
        const enabled =
          (await _internals.run("omarchy", ["toggle", "enabled", args.flag]))
            .ok;
        const handle = await context.writeResource(
          "toggles",
          `toggle-${args.flag}`,
          { flag: args.flag, enabled, changedAt: new Date().toISOString() },
        );
        context.logger.info("Toggle {flag} is now {enabled}", {
          flag: args.flag,
          enabled,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
