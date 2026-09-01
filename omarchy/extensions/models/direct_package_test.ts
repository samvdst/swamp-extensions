import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260828.33";
import { _internals, model } from "./direct_package.ts";

const globalArgs = {
  packageName: "grok-bot",
  source: "https://example.test/grok-bot-0.30.0-1-x86_64.pkg.tar.zst",
};

async function artifact(version = "0.30.0-1") {
  return {
    path: "/tmp/grok-bot.pkg.tar.zst",
    workDir: "/tmp/direct-package-test-do-not-create",
    finalSource: globalArgs.source,
    filename: "grok-bot-0.30.0-1-x86_64.pkg.tar.zst",
    size: 123,
    sha256: "a".repeat(64),
    etag: '"release-30"',
    lastModified: "Sun, 30 Aug 2026 00:00:00 GMT",
    packageName: globalArgs.packageName,
    version,
    architecture: "x86_64",
    log: [`Package: grok-bot ${version}`],
  };
}

function context() {
  const test = createModelTestContext();
  return {
    ...test,
    context: Object.assign(test.context, { globalArgs }),
  };
}

function fileText(content: string | Uint8Array): string {
  return typeof content === "string"
    ? content
    : new TextDecoder().decode(content);
}

Deno.test("parses Arch package metadata", () => {
  assertEquals(
    _internals.parsePkgInfo(
      "pkgname = grok-bot\npkgver = 0.30.0-1\narch = x86_64\n",
    ),
    {
      packageName: "grok-bot",
      version: "0.30.0-1",
      architecture: "x86_64",
    },
  );
});

Deno.test("sync records an available direct-package update", async () => {
  const originalPrepare = _internals.prepareArtifact;
  const originalInstalled = _internals.installedVersion;
  const originalCompare = _internals.compareVersions;
  _internals.prepareArtifact = () => artifact("0.30.0-1");
  _internals.installedVersion = () => Promise.resolve("0.29.0-1");
  _internals.compareVersions = () => Promise.resolve(1);
  try {
    const test = context();
    await model.methods.sync.execute({}, test.context);
    const state = test.getWrittenResources()[0].data;
    assertEquals(state.status, "update-available");
    assertEquals(state.installedVersion, "0.29.0-1");
    assertEquals(state.artifactVersion, "0.30.0-1");
    assertStringIncludes(
      fileText(test.getWrittenFiles()[0].content),
      "grok-bot 0.30.0-1",
    );
  } finally {
    _internals.prepareArtifact = originalPrepare;
    _internals.installedVersion = originalInstalled;
    _internals.compareVersions = originalCompare;
  }
});

Deno.test("install registers an absent package and its provenance", async () => {
  const originalPrepare = _internals.prepareArtifact;
  const originalInstalled = _internals.installedVersion;
  const originalInstall = _internals.installArtifact;
  let checks = 0;
  let installed = false;
  _internals.prepareArtifact = () => artifact();
  _internals.installedVersion = () =>
    Promise.resolve(checks++ === 0 ? null : "0.30.0-1");
  _internals.installArtifact = () => {
    installed = true;
    return Promise.resolve("installed with pacman");
  };
  try {
    const test = context();
    await model.methods.install.execute({}, test.context);
    assert(installed);
    const state = test.getWrittenResources()[0].data;
    assertEquals(state.status, "installed");
    assertEquals(state.installedVersion, "0.30.0-1");
    assertEquals(state.artifactSha256, "a".repeat(64));
  } finally {
    _internals.prepareArtifact = originalPrepare;
    _internals.installedVersion = originalInstalled;
    _internals.installArtifact = originalInstall;
  }
});

Deno.test("update skips a current Arch package", async () => {
  const originalPrepare = _internals.prepareArtifact;
  const originalInstalled = _internals.installedVersion;
  const originalCompare = _internals.compareVersions;
  const originalInstall = _internals.installArtifact;
  let installed = false;
  _internals.prepareArtifact = () => artifact();
  _internals.installedVersion = () => Promise.resolve("0.30.0-1");
  _internals.compareVersions = () => Promise.resolve(0);
  _internals.installArtifact = () => {
    installed = true;
    return Promise.resolve("");
  };
  try {
    const test = context();
    await model.methods.update.execute({}, test.context);
    assertEquals(installed, false);
    assertEquals(test.getWrittenResources()[0].data.status, "current");
  } finally {
    _internals.prepareArtifact = originalPrepare;
    _internals.installedVersion = originalInstalled;
    _internals.compareVersions = originalCompare;
    _internals.installArtifact = originalInstall;
  }
});

Deno.test("replace reinstalls even when the version is current", async () => {
  const originalPrepare = _internals.prepareArtifact;
  const originalInstalled = _internals.installedVersion;
  const originalInstall = _internals.installArtifact;
  let checks = 0;
  let installed = false;
  _internals.prepareArtifact = () => artifact();
  _internals.installedVersion = () =>
    Promise.resolve(checks++ === 0 ? "0.30.0-1" : "0.30.0-2");
  _internals.installArtifact = () => {
    installed = true;
    return Promise.resolve("replaced with pacman");
  };
  try {
    const test = context();
    await model.methods.replace.execute({}, test.context);
    assert(installed);
    const state = test.getWrittenResources()[0].data;
    assertEquals(state.status, "replaced");
    assertEquals(state.installedVersion, "0.30.0-2");
  } finally {
    _internals.prepareArtifact = originalPrepare;
    _internals.installedVersion = originalInstalled;
    _internals.installArtifact = originalInstall;
  }
});

Deno.test("delete removes and records a managed package", async () => {
  const originalInstalled = _internals.installedVersion;
  const originalRemove = _internals.removePackage;
  let checks = 0;
  let removed = false;
  _internals.installedVersion = () =>
    Promise.resolve(checks++ === 0 ? "0.30.0-1" : null);
  _internals.removePackage = () => {
    removed = true;
    return Promise.resolve("removed with pacman");
  };
  try {
    const test = context();
    await model.methods.delete.execute({}, test.context);
    assert(removed);
    const state = test.getWrittenResources()[0].data;
    assertEquals(state.status, "removed");
    assertEquals(state.installedVersion, null);
  } finally {
    _internals.installedVersion = originalInstalled;
    _internals.removePackage = originalRemove;
  }
});
