import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260828.33";
import { _internals, model } from "./omarchy.ts";

type RunResult = { ok: boolean; code: number; output: string };

const ok = (output = ""): RunResult => ({ ok: true, code: 0, output });
const fail = (output = "", code = 1): RunResult => ({ ok: false, code, output });

const machine: Record<string, RunResult> = {
  "omarchy version": ok("4.0.1-1"),
  "omarchy channel current": ok("stable"),
  "omarchy theme current": ok("Ristretto"),
  "omarchy theme bg current": ok("Launch"),
  "omarchy font current": ok("JetBrainsMono Nerd Font"),
  "omarchy update available": fail("Omarchy is up to date"),
  "pacman -Qq": ok("acl\nbash\nhyprland"),
};

function fileText(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder().decode(content);
}

function stubRun(overrides: Record<string, RunResult> = {}) {
  const original = _internals.run;
  const table = { ...machine, ...overrides };
  const calls: string[] = [];
  _internals.run = (bin: string, args: string[]) => {
    const cmd = [bin, ...args].join(" ");
    calls.push(cmd);
    const result = table[cmd];
    return result
      ? Promise.resolve(result)
      : Promise.reject(new Error(`unexpected command: ${cmd}`));
  };
  return {
    calls,
    restore: () => {
      _internals.run = original;
    },
  };
}

Deno.test("sync writes state and package inventory", async () => {
  const stub = stubRun();
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await model.methods.sync.execute({}, context);

    const written = getWrittenResources();
    assertEquals(written.length, 2);
    const state = written.find((w) => w.specName === "state");
    assert(state);
    assertEquals(state.data.version, "4.0.1-1");
    assertEquals(state.data.theme, "Ristretto");
    assertEquals(state.data.updateAvailable, false);
    assertEquals(state.data.updateMessage, "Omarchy is up to date");
    const packages = written.find((w) => w.specName === "packages");
    assert(packages);
    assertEquals(packages.data.count, 3);
    assertEquals(packages.data.installed, ["acl", "bash", "hyprland"]);
  } finally {
    stub.restore();
  }
});

Deno.test("sync throws and writes nothing when omarchy is missing", async () => {
  const stub = stubRun({ "omarchy version": fail("command not found", 127) });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await assertRejects(
      () => model.methods.sync.execute({}, context),
      Error,
      "omarchy version failed (exit 127)",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("update persists the log and re-snapshots on success", async () => {
  const stub = stubRun({ "omarchy update -y": ok("updated 42 packages") });
  try {
    const { context, getWrittenFiles, getWrittenResources } =
      createModelTestContext();
    await model.methods.update.execute({}, context);

    const files = getWrittenFiles();
    assertEquals(files.length, 1);
    assertEquals(files[0].specName, "updateLog");
    assertStringIncludes(fileText(files[0].content), "updated 42 packages");
    assertEquals(getWrittenResources().length, 2);
  } finally {
    stub.restore();
  }
});

Deno.test("update failure still persists the log, then throws", async () => {
  const stub = stubRun({
    "omarchy update -y": fail("error: conflicting dependencies", 1),
  });
  try {
    const { context, getWrittenFiles, getWrittenResources } =
      createModelTestContext();
    await assertRejects(
      () => model.methods.update.execute({}, context),
      Error,
      "omarchy update failed (exit 1)",
    );
    const files = getWrittenFiles();
    assertEquals(files.length, 1);
    assertStringIncludes(
      fileText(files[0].content),
      "conflicting dependencies",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("theme applies and captures the new state", async () => {
  const stub = stubRun({
    "omarchy theme set Nord": ok(),
    "omarchy theme current": ok("Nord"),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await model.methods.theme.execute({ name: "Nord" }, context);

    const state = getWrittenResources().find((w) => w.specName === "state");
    assert(state);
    assertEquals(state.data.theme, "Nord");
  } finally {
    stub.restore();
  }
});

Deno.test("theme throws on an unknown theme without writing", async () => {
  const stub = stubRun({
    "omarchy theme set Bogus": fail("Unknown theme: Bogus"),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await assertRejects(
      () => model.methods.theme.execute({ name: "Bogus" }, context),
      Error,
      "omarchy theme set Bogus failed",
    );
    assertEquals(getWrittenResources().length, 0);
  } finally {
    stub.restore();
  }
});

Deno.test("pkg installs, verifies, and refreshes the inventory", async () => {
  const stub = stubRun({
    "omarchy pkg add htop": ok(),
    "omarchy pkg present htop": ok(),
    "pacman -Qq": ok("acl\nhtop"),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await model.methods.pkg.execute(
      { add: ["htop"], aurAdd: [], drop: [] },
      context,
    );

    assert(stub.calls.includes("omarchy pkg add htop"));
    assert(stub.calls.includes("omarchy pkg present htop"));
    const packages = getWrittenResources().find(
      (w) => w.specName === "packages",
    );
    assert(packages);
    assertEquals(packages.data.installed, ["acl", "htop"]);
  } finally {
    stub.restore();
  }
});

Deno.test("pkg rejects an empty request", async () => {
  const { context } = createModelTestContext();
  await assertRejects(
    () => model.methods.pkg.execute({ add: [], aurAdd: [], drop: [] }, context),
    Error,
    "at least one",
  );
});

Deno.test("toggle records the resulting flag state", async () => {
  const stub = stubRun({
    "omarchy toggle nightlight on": ok(),
    "omarchy toggle enabled nightlight": ok(),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await model.methods.toggle.execute(
      { flag: "nightlight", state: "on" },
      context,
    );

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].specName, "toggles");
    assertEquals(written[0].name, "toggle-nightlight");
    assertEquals(written[0].data.flag, "nightlight");
    assertEquals(written[0].data.enabled, true);
  } finally {
    stub.restore();
  }
});

Deno.test("toggle records a disabled flag as disabled", async () => {
  const stub = stubRun({
    "omarchy toggle idle off": ok(),
    "omarchy toggle enabled idle": fail(),
  });
  try {
    const { context, getWrittenResources } = createModelTestContext();
    await model.methods.toggle.execute({ flag: "idle", state: "off" }, context);
    assertEquals(getWrittenResources()[0].data.enabled, false);
  } finally {
    stub.restore();
  }
});

Deno.test("omarchy-present check passes when the CLI responds", async () => {
  const stub = stubRun();
  try {
    const result = await model.checks["omarchy-present"].execute();
    assertEquals(result.pass, true);
  } finally {
    stub.restore();
  }
});

Deno.test("omarchy-present check fails with a reason when it does not", async () => {
  const stub = stubRun({ "omarchy version": fail("not found", 127) });
  try {
    const result = await model.checks["omarchy-present"].execute();
    assertEquals(result.pass, false);
    assert(result.errors?.[0].includes("not found"));
  } finally {
    stub.restore();
  }
});
