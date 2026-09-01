/**
 * Tracks direct-download packages as native pacman installations, with
 * versioned provenance and operation logs in swamp's datastore.
 *
 * @module
 */
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  packageName: z.string().regex(/^[a-z0-9@._+:-]+$/).describe(
    "Package name expected in pacman's database",
  ),
  source: z.string().refine(
    (value) => value.startsWith("https://") || value.startsWith("/"),
    "Source must be an HTTPS URL or absolute local path",
  ).describe(
    "HTTPS URL or absolute path to a native Arch .pkg.tar.zst package",
  ),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional().describe(
    "Optional expected artifact SHA-256",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = z.object({
  packageName: z.string(),
  source: z.string(),
  finalSource: z.string().nullable(),
  artifactFilename: z.string().nullable(),
  artifactSize: z.number().nullable(),
  artifactSha256: z.string().nullable(),
  etag: z.string().nullable(),
  lastModified: z.string().nullable(),
  artifactVersion: z.string().nullable(),
  architecture: z.string().nullable(),
  installedVersion: z.string().nullable(),
  action: z.enum(["sync", "install", "update", "replace", "delete"]),
  status: z.enum([
    "absent",
    "current",
    "update-available",
    "source-older",
    "installed",
    "updated",
    "replaced",
    "removed",
  ]),
  recordedAt: z.string(),
});

type State = z.infer<typeof StateSchema>;

interface RunResult {
  ok: boolean;
  code: number;
  output: string;
}

interface Artifact {
  path: string;
  workDir: string;
  finalSource: string;
  filename: string;
  size: number;
  sha256: string;
  etag: string | null;
  lastModified: string | null;
  packageName: string;
  version: string;
  architecture: string;
  log: string[];
}

interface PackageMetadata {
  packageName: string;
  version: string;
  architecture: string;
}

interface Context {
  globalArgs: GlobalArgs;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  createFileWriter(
    specName: string,
    name: string,
  ): { writeText(text: string): Promise<{ name: string }> };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run(bin: string, args: string[]): Promise<RunResult> {
  try {
    const output = await new Deno.Command(bin, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(output.stdout);
    const error = new TextDecoder().decode(output.stderr);
    return {
      ok: output.success,
      code: output.code,
      output: [text.trim(), error.trim()].filter(Boolean).join("\n"),
    };
  } catch (error) {
    return { ok: false, code: 127, output: String(error) };
  }
}

async function runInTerminal(bin: string, args: string[]): Promise<RunResult> {
  const workDir = await Deno.makeTempDir({ prefix: "swamp-direct-package-" });
  const exitFile = `${workDir}/exit`;
  const logFile = `${workDir}/log`;
  try {
    const command = ["sudo", bin, ...args].map(shellQuote).join(" ");
    const launch = await run("setsid", [
      "uwsm-app",
      "--",
      "xdg-terminal-exec",
      "--app-id=org.omarchy.terminal",
      "--title=Direct Package",
      "-e",
      "bash",
      "-c",
      `${command} &>${shellQuote(logFile)}; echo $? > ${shellQuote(exitFile)}`,
    ]);
    if (!launch.ok) {
      throw new Error(
        `could not open authentication terminal: ${launch.output}`,
      );
    }
    // ponytail: one global package-manager lock and a 45min ceiling are enough
    const deadline = Date.now() + 45 * 60 * 1000;
    while (Date.now() < deadline) {
      const marker = await Deno.readTextFile(exitFile).catch(() => null);
      if (marker !== null) {
        const code = parseInt(marker.trim(), 10);
        const output = await Deno.readTextFile(logFile).catch(() => "");
        return { ok: code === 0, code, output: output.trim() };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("timed out waiting for the package operation terminal");
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
  }
}

async function privileged(bin: string, args: string[]): Promise<RunResult> {
  const sudo = await run("sudo", ["-n", "true"]);
  return sudo.ok
    ? await run("sudo", [bin, ...args])
    : await runInTerminal(bin, args);
}

function parsePkgInfo(text: string): PackageMetadata {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (match) fields.set(match[1].trim(), match[2].trim());
  }
  const packageName = fields.get("pkgname");
  const version = fields.get("pkgver");
  const architecture = fields.get("arch");
  if (!packageName || !version || !architecture) {
    throw new Error(
      "Arch package metadata is missing pkgname, pkgver, or arch",
    );
  }
  return { packageName, version, architecture };
}

async function inspectArtifact(path: string): Promise<PackageMetadata> {
  const list = await run("bsdtar", ["-tf", path]);
  if (!list.ok) throw new Error(`cannot inspect ${path}: ${list.output}`);
  const entry = list.output.split("\n").find((line) =>
    line.endsWith(".PKGINFO")
  );
  if (!entry) {
    throw new Error("source is not an Arch package: missing .PKGINFO");
  }
  const info = await run("bsdtar", ["-xOf", path, entry]);
  if (!info.ok) throw new Error(`cannot read .PKGINFO: ${info.output}`);
  return parsePkgInfo(info.output);
}

function basename(value: string): string {
  return value.split("/").filter(Boolean).at(-1) ?? "artifact";
}

async function prepareArtifact(args: GlobalArgs): Promise<Artifact> {
  const workDir = await Deno.makeTempDir({ prefix: "swamp-direct-package-" });
  const log: string[] = [];
  try {
    let finalSource = args.source;
    let filename: string;
    let path: string;
    let etag: string | null = null;
    let lastModified: string | null = null;

    if (args.source.startsWith("https://")) {
      const response = await fetch(args.source, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(
          `download failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
      finalSource = response.url;
      filename = basename(new URL(response.url).pathname);
      path = `${workDir}/artifact.pkg.tar.zst`;
      const file = await Deno.open(path, {
        create: true,
        write: true,
        truncate: true,
      });
      await response.body.pipeTo(file.writable);
      etag = response.headers.get("etag");
      lastModified = response.headers.get("last-modified");
      log.push(`Downloaded ${args.source}`, `Final URL: ${finalSource}`);
      for (
        const [header, value] of [
          ["etag", etag],
          ["last-modified", lastModified],
          ["content-length", response.headers.get("content-length")],
        ]
      ) {
        if (value) log.push(`${header}: ${value}`);
      }
    } else {
      filename = basename(args.source);
      path = `${workDir}/artifact.pkg.tar.zst`;
      await Deno.copyFile(args.source, path);
      log.push(`Copied ${args.source}`);
    }

    if (!filename.endsWith(".pkg.tar.zst")) {
      throw new Error(`source must end in .pkg.tar.zst: ${filename}`);
    }
    const hash = await run("sha256sum", [path]);
    if (!hash.ok) throw new Error(`sha256sum failed: ${hash.output}`);
    const sha256 = hash.output.split(/\s+/)[0].toLowerCase();
    const expected = args.sha256?.toLowerCase();
    if (expected && sha256 !== expected) {
      throw new Error(`SHA-256 mismatch: expected ${expected}, got ${sha256}`);
    }
    const metadata = await inspectArtifact(path);
    if (metadata.packageName !== args.packageName) {
      throw new Error(
        `artifact contains package ${metadata.packageName}, expected ${args.packageName}`,
      );
    }
    const size = (await Deno.stat(path)).size;
    log.push(
      `Artifact: ${filename}`,
      `SHA-256: ${sha256}`,
      `Package: ${metadata.packageName} ${metadata.version} (${metadata.architecture})`,
    );
    return {
      path,
      workDir,
      finalSource,
      filename,
      size,
      sha256,
      etag,
      lastModified,
      ...metadata,
      log,
    };
  } catch (error) {
    await Deno.remove(workDir, { recursive: true }).catch(() => {});
    throw error;
  }
}

async function installedVersion(packageName: string): Promise<string | null> {
  const result = await run("pacman", ["-Q", packageName]);
  if (!result.ok) return null;
  const [, version] = result.output.split(/\s+/, 2);
  if (!version) throw new Error(`unexpected pacman output: ${result.output}`);
  return version;
}

async function compareVersions(left: string, right: string): Promise<number> {
  const result = await run("vercmp", [left, right]);
  if (!result.ok) throw new Error(`vercmp failed: ${result.output}`);
  const comparison = parseInt(result.output, 10);
  if (!Number.isInteger(comparison)) {
    throw new Error(`unexpected vercmp output: ${result.output}`);
  }
  return comparison;
}

async function installArtifact(artifact: Artifact): Promise<string> {
  const result = await privileged("pacman", [
    "-U",
    "--noconfirm",
    artifact.path,
  ]);
  if (!result.ok) throw new Error(`pacman install failed: ${result.output}`);
  return result.output;
}

async function removePackage(packageName: string): Promise<string> {
  const result = await privileged("pacman", [
    "-Rns",
    "--noconfirm",
    packageName,
  ]);
  if (!result.ok) throw new Error(`pacman removal failed: ${result.output}`);
  return result.output;
}

/** Test seams for artifact and package-manager operations. */
export const _internals = {
  run,
  prepareArtifact,
  installedVersion,
  compareVersions,
  installArtifact,
  removePackage,
  parsePkgInfo,
};

function stateFor(
  args: GlobalArgs,
  action: State["action"],
  status: State["status"],
  installed: string | null,
  artifact?: Artifact,
): State {
  return {
    packageName: args.packageName,
    source: args.source,
    finalSource: artifact?.finalSource ?? null,
    artifactFilename: artifact?.filename ?? null,
    artifactSize: artifact?.size ?? null,
    artifactSha256: artifact?.sha256 ?? null,
    etag: artifact?.etag ?? null,
    lastModified: artifact?.lastModified ?? null,
    artifactVersion: artifact?.version ?? null,
    architecture: artifact?.architecture ?? null,
    installedVersion: installed,
    action,
    status,
    recordedAt: new Date().toISOString(),
  };
}

async function writeOperation(
  context: Context,
  state: State,
  log: string[],
): Promise<Array<{ name: string }>> {
  const resource = await context.writeResource("state", "state", state);
  const file = await context.createFileWriter("operationLog", "operationLog")
    .writeText(log.filter(Boolean).join("\n"));
  return [resource, file];
}

async function sync(context: Context) {
  const artifact = await _internals.prepareArtifact(context.globalArgs);
  try {
    const installed = await _internals.installedVersion(
      context.globalArgs.packageName,
    );
    let status: State["status"] = "absent";
    if (installed !== null) {
      const comparison = await _internals.compareVersions(
        artifact.version,
        installed,
      );
      status = comparison > 0
        ? "update-available"
        : comparison < 0
        ? "source-older"
        : "current";
    }
    return {
      dataHandles: await writeOperation(
        context,
        stateFor(context.globalArgs, "sync", status, installed, artifact),
        artifact.log,
      ),
    };
  } finally {
    await Deno.remove(artifact.workDir, { recursive: true }).catch(() => {});
  }
}

async function apply(
  action: "install" | "update" | "replace",
  context: Context,
) {
  const log: string[] = [];
  let artifact: Artifact | undefined;
  try {
    artifact = await _internals.prepareArtifact(context.globalArgs);
    log.push(...artifact.log);
    const before = await _internals.installedVersion(
      context.globalArgs.packageName,
    );
    const comparison = before === null
      ? 1
      : action === "replace"
      ? 0
      : await _internals.compareVersions(artifact.version, before);

    if (
      action !== "replace" &&
      (comparison === 0 || (action === "update" && comparison < 0))
    ) {
      const status = comparison === 0 ? "current" : "source-older";
      return {
        dataHandles: await writeOperation(
          context,
          stateFor(context.globalArgs, action, status, before, artifact),
          log,
        ),
      };
    }

    context.logger.info("Installing {package} {version}", {
      package: artifact.packageName,
      version: artifact.version,
    });
    log.push(await _internals.installArtifact(artifact));
    const installed = await _internals.installedVersion(
      context.globalArgs.packageName,
    );
    if (installed === null) {
      throw new Error("pacman did not register the package");
    }
    return {
      dataHandles: await writeOperation(
        context,
        stateFor(
          context.globalArgs,
          action,
          before === null
            ? "installed"
            : action === "replace"
            ? "replaced"
            : "updated",
          installed,
          artifact,
        ),
        log,
      ),
    };
  } catch (error) {
    log.push(`ERROR: ${error}`);
    await context.createFileWriter("operationLog", "operationLog")
      .writeText(log.join("\n"));
    throw error;
  } finally {
    if (artifact) {
      await Deno.remove(artifact.workDir, { recursive: true }).catch(() => {});
    }
  }
}

/** Direct-download package lifecycle model. */
export const model = {
  type: "@samvdst/omarchy/direct-package",
  version: "2026.08.30.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Direct package provenance and installed state",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  files: {
    operationLog: {
      description: "Download, installation, and removal output",
      contentType: "text/plain",
      lifetime: "1y",
      garbageCollection: 50,
    },
  },
  checks: {
    "host-tools": {
      description: "Require Arch package inspection and management tools",
      labels: ["dependency"],
      execute: async (): Promise<{ pass: boolean; errors?: string[] }> => {
        const missing: string[] = [];
        for (
          const tool of ["bsdtar", "pacman", "sha256sum", "vercmp"]
        ) {
          if (!(await _internals.run("which", [tool])).ok) missing.push(tool);
        }
        return missing.length
          ? {
            pass: false,
            errors: [`Missing host tools: ${missing.join(", ")}`],
          }
          : { pass: true };
      },
    },
  },
  methods: {
    sync: {
      description:
        "Inspect the source artifact and compare it with the installed package",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) =>
        await sync(context),
    },
    install: {
      description: "Download, verify, and install through pacman",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) =>
        await apply("install", context),
    },
    update: {
      description: "Install the source only when its version is newer",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) =>
        await apply("update", context),
    },
    replace: {
      description:
        "Force the configured source to replace the installed package",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) =>
        await apply("replace", context),
    },
    delete: {
      description: "Remove the package through pacman and record the result",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const before = await _internals.installedVersion(
          context.globalArgs.packageName,
        );
        const log: string[] = [];
        if (before !== null) {
          context.logger.info("Removing {package}", {
            package: context.globalArgs.packageName,
          });
          log.push(
            await _internals.removePackage(context.globalArgs.packageName),
          );
        }
        const installed = await _internals.installedVersion(
          context.globalArgs.packageName,
        );
        if (installed !== null) {
          throw new Error(`package is still installed: ${installed}`);
        }
        return {
          dataHandles: await writeOperation(
            context,
            stateFor(
              context.globalArgs,
              "delete",
              before === null ? "absent" : "removed",
              null,
            ),
            log,
          ),
        };
      },
    },
  },
};
