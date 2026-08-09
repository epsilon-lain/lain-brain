// ── Lean Runner ────────────────────────────────────────────────────────
// Injectable Lean 4 checker using child_process.spawn.
//
// Supports two execution modes:
//   native — Lean runs directly on the same OS as Obsidian
//   wsl    — Obsidian on Windows, Lean inside WSL (Arch by default)
//
// The production runner:
//  - uses child_process.spawn with argument arrays (never shell strings)
//  - in native mode: writes a temporary .lean file in the OS temp dir
//  - in wsl mode: writes a temporary .lean file inside
//    <project-root>/.lain-brain-tmp and passes the WSL path to Lean
//  - captures stdout, stderr, and exit code
//  - always removes the temporary file
//  - enforces a configurable timeout
//
// spawn and filesystem operations are injectable through constructor
// options so that unit tests can verify cleanup without requiring
// Lean or Mathlib to be installed.
// ────────────────────────────────────────────────────────────────────────

import { spawn as nodeSpawn } from "child_process";
import type { ChildProcess } from "child_process";
import {
  mkdirSync as nodeMkdirSync,
  mkdtempSync as nodeMkdtempSync,
  writeFileSync as nodeWriteFileSync,
  rmSync as nodeRmSync
} from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import type {
  LeanRunner,
  LeanCheckRequest,
  LeanCheckResult,
  LeanDiagnostic
} from "./FormalizationProtocol";

// ── Configuration ──────────────────────────────────────────────────────

export type LeanExecutionMode = "native" | "wsl";

export interface LeanRunnerConfig {
  /** Execution mode. */
  mode: LeanExecutionMode;
  /** Absolute path to the Lean project root (contains lakefile.lean). */
  projectRoot: string;
  /** Executable name or path, default "lake". */
  executable: string;
  /** Arguments placed before the temp file path, default ["env", "lean"]. */
  args: string[];
  /** Timeout in seconds, default 30. */
  timeoutSeconds: number;
  /** WSL executable, default "wsl.exe". */
  wslExecutable: string;
  /** WSL distribution name, default "". */
  wslDistribution: string;
  /** WSL-side project root path, e.g. /mnt/c/Users/.../lain_lean. */
  wslProjectRoot: string;
}

/** Overrides applied to a single spawn call for diagnostics. */
export interface SpawnOverrides {
  stdio?: ["ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit"];
  windowsHide?: boolean;
  /** Called immediately after spawn with the live ChildProcess. */
  onSpawn?: (child: ChildProcess) => void;
  /** If provided, raw Buffer chunks from stderr are pushed here before
   *  UTF-8 decoding.  Used by the command-ladder diagnostic to inspect
   *  encoding. */
  rawStderrChunks?: Buffer[];
}

/** One rung in the WSL command ladder. */
export interface WslLadderResult {
  label: string;
  command: string;
  status: "success" | "timeout" | "spawn_error" | "exit_error";
  exitCode: number;
  elapsedMs: number;
  sawExit: boolean;
  sawClose: boolean;
  stdout: string;
  stderr: string;
  /** Hex dump of the first 64 raw bytes of stderr (empty if no stderr). */
  stderrHexFirstBytes: string;
  /** True when the raw stderr bytes show a UTF-16LE pattern
   *  (interleaved NUL bytes). */
  stderrLooksUtf16LE: boolean;
}

/** Aggregate result from runWslCommandLadder. */
export interface WslLadderResults {
  results: WslLadderResult[];
  interpretation: string;
}

export const DEFAULT_LEAN_RUNNER_CONFIG: LeanRunnerConfig = {
  mode: "native",
  projectRoot: "",
  executable: "lake",
  args: ["env", "lean"],
  timeoutSeconds: 30,
  wslExecutable: "wsl.exe",
  wslDistribution: "",
  wslProjectRoot: "/mnt/c/Users/elonl/Desktop/lain_lean"
};

// ── Injectables ────────────────────────────────────────────────────────

export interface LeanRunnerDeps {
  spawn: typeof nodeSpawn;
  mkdirSync: typeof nodeMkdirSync;
  mkdtempSync: typeof nodeMkdtempSync;
  writeFileSync: typeof nodeWriteFileSync;
  rmSync: typeof nodeRmSync;
}

const defaultDeps: LeanRunnerDeps = {
  spawn: nodeSpawn,
  mkdirSync: nodeMkdirSync,
  mkdtempSync: nodeMkdtempSync,
  writeFileSync: nodeWriteFileSync,
  rmSync: nodeRmSync
};

// ── WSL Path Helpers ───────────────────────────────────────────────────

export function wslPathToWindows(wslPath: string): string | null {
  if (typeof wslPath !== "string" || wslPath.trim() === "") {
    return null;
  }

  const match = wslPath.match(/^\/mnt\/([a-z])(\/|$)/i);

  if (match === null || match[1] === undefined) {
    return null;
  }

  const drive = match[1].toUpperCase() + ":";
  const rest = wslPath.slice(match[0].length);

  return drive + sep + rest.replace(/\//g, sep);
}

export function resolveWslWindowsPath(
  wslProjectRoot: string
): { ok: true; windowsPath: string } | { ok: false; diagnostic: LeanDiagnostic } {
  const windowsPath = wslPathToWindows(wslProjectRoot);

  if (windowsPath === null) {
    return {
      ok: false,
      diagnostic: {
        severity: "error",
        message:
          "WSL project root must start with /mnt/<drive>/ to be accessible " +
          "from Windows. Received: " +
          (wslProjectRoot || "(empty)")
      }
    };
  }

  return { ok: true, windowsPath };
}

export function pathToWsl(windowsPath: string): string {
  const drive = windowsPath.charAt(0).toLowerCase();

  if (
    windowsPath.length >= 2 &&
    windowsPath.charAt(1) === ":"
  ) {
    return "/mnt/" + drive + windowsPath.slice(2).replace(/\\/g, "/");
  }

  return windowsPath.replace(/\\/g, "/");
}

// ── WSL Argument Builder ───────────────────────────────────────────────

export function buildWslArguments(params: {
  wslDistribution: string;
  wslProjectRoot: string;
  leanExecutable: string;
  leanArgs: readonly string[];
  wslTempFile: string;
}): string[] {
  const distro = params.wslDistribution.trim();

  const prefix = distro !== ""
    ? ["-d", distro]
    : [];

  return [
    ...prefix,
    "--cd",
    params.wslProjectRoot,
    "--",
    params.leanExecutable,
    ...params.leanArgs,
    params.wslTempFile
  ];
}

// ── Production Runner ──────────────────────────────────────────────────

export class SpawnLeanRunner implements LeanRunner {
  private readonly deps: LeanRunnerDeps;

  constructor(
    private config: LeanRunnerConfig,
    deps?: Partial<LeanRunnerDeps>
  ) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async check(request: LeanCheckRequest): Promise<LeanCheckResult> {
    if (this.config.mode === "wsl") {
      return this.checkWsl(request);
    }

    return this.checkNative(request);
  }

  private async checkNative(
    request: LeanCheckRequest
  ): Promise<LeanCheckResult> {
    const executable = this.config.executable || "lake";
    const args = [...(this.config.args ?? ["env", "lean"])];
    const timeoutSeconds =
      request.timeoutSeconds ?? this.config.timeoutSeconds ?? 30;

    const tmpDir = this.deps.mkdtempSync(join(tmpdir(), "lain-lean-"));
    const tmpFile = join(tmpDir, "lain_check.lean");

    try {
      this.deps.writeFileSync(tmpFile, request.code, "utf-8");
      const allArgs = [...args, tmpFile];

      return await this.runProcess(
        executable,
        allArgs,
        this.config.projectRoot || undefined,
        timeoutSeconds
      );
    } finally {
      try {
        this.deps.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private async checkWsl(
    request: LeanCheckRequest
  ): Promise<LeanCheckResult> {
    const wslProjectRoot = this.config.wslProjectRoot;

    // Project root must be an absolute Linux path (e.g. /root/lain_lean_fast).
    // It does NOT need to be Windows-accessible — only the temp .lean file
    // must live on a path that both Windows and WSL can reach.
    if (!wslProjectRoot.startsWith("/")) {
      return {
        status: "error",
        diagnostics: [
          {
            severity: "error",
            message:
              "WSL project root must be an absolute path starting with /. " +
              "Received: " + (wslProjectRoot || "(empty)")
          }
        ],
        exitCode: -1,
        stdout: "",
        stderr: ""
      };
    }

    // Temp files live under the OS temp directory, which is always on the
    // Windows filesystem and therefore reachable from WSL via /mnt/c/... .
    const tmpDir = this.deps.mkdtempSync(
      join(tmpdir(), "lain-lean-")
    );
    const tmpFile = join(tmpDir, "lain_check.lean");
    const wslTmpFile = pathToWsl(tmpFile);

    try {
      this.deps.writeFileSync(tmpFile, request.code, "utf-8");

      const timeoutSeconds =
        request.timeoutSeconds ?? this.config.timeoutSeconds ?? 30;

      const wslArgs = buildWslArguments({
        wslDistribution: this.config.wslDistribution,
        wslProjectRoot,
        leanExecutable:
          this.config.executable || "lake",
        leanArgs: this.config.args ?? ["env", "lean"],
        wslTempFile: wslTmpFile
      });

      return await this.runProcess(
        this.config.wslExecutable || "wsl.exe",
        wslArgs,
        undefined,
        timeoutSeconds
      );
    } finally {
      try {
        this.deps.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  /** Public entry point for WSL spawn diagnostics.
   *
   *  Mirrors `checkWsl` but accepts spawn overrides so that the
   *  diagnostic facility can test different process-creation flags
   *  without affecting normal claim checking. */
  public async diagnosticWslCheck(
    request: LeanCheckRequest,
    spawnOverrides: SpawnOverrides
  ): Promise<LeanCheckResult> {
    const wslProjectRoot = this.config.wslProjectRoot;

    // Same validation as checkWsl: absolute Linux path required.
    if (!wslProjectRoot.startsWith("/")) {
      return {
        status: "error",
        diagnostics: [
          {
            severity: "error",
            message:
              "WSL project root must be an absolute path starting with /. " +
              "Received: " + (wslProjectRoot || "(empty)")
          }
        ],
        exitCode: -1,
        stdout: "",
        stderr: ""
      };
    }

    // Temp files live under the OS temp directory.
    const tmpDir = this.deps.mkdtempSync(
      join(tmpdir(), "lain-lean-")
    );
    const tmpFile = join(tmpDir, "lain_check.lean");
    const wslTmpFile = pathToWsl(tmpFile);

    try {
      this.deps.writeFileSync(tmpFile, request.code, "utf-8");

      const timeoutSeconds =
        request.timeoutSeconds ?? this.config.timeoutSeconds ?? 30;

      const wslArgs = buildWslArguments({
        wslDistribution: this.config.wslDistribution,
        wslProjectRoot,
        leanExecutable:
          this.config.executable || "lake",
        leanArgs: this.config.args ?? ["env", "lean"],
        wslTempFile: wslTmpFile
      });

      return await this.runProcess(
        this.config.wslExecutable || "wsl.exe",
        wslArgs,
        undefined,
        timeoutSeconds,
        spawnOverrides
      );
    } finally {
      try {
        this.deps.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  /** Run a raw command through the shared process runner with the given
   *  spawn overrides.  Intended for diagnostic use only — does not write
   *  temp files or build WSL arguments. */
  public async runDiagnosticCommand(
    executable: string,
    allArgs: string[],
    timeoutSeconds: number,
    spawnOverrides?: SpawnOverrides
  ): Promise<LeanCheckResult> {
    return await this.runProcess(
      executable,
      allArgs,
      undefined,
      timeoutSeconds,
      spawnOverrides
    );
  }

  // ── Shared process runner ───────────────────────────────────────────

  private async runProcess(
    executable: string,
    allArgs: string[],
    cwd: string | undefined,
    timeoutSeconds: number,
    spawnOverrides?: SpawnOverrides
  ): Promise<LeanCheckResult> {
    const limitMs = timeoutSeconds * 1000;
    const drainGraceMs = 200;
    const startMs = Date.now();

    type RawOutcome =
      | { kind: "close"; exitCode: number }
      | { kind: "timeout" }
      | { kind: "spawn_error"; message: string };

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      outcome: RawOutcome;
      sawExit: boolean;
      sawClose: boolean;
      exitSignal: string | null;
      usedExitFallback: boolean;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let mainTimer: ReturnType<typeof setTimeout> | null = null;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      let sawExit = false;
      let sawClose = false;
      let usedExitFallback = false;

      function finish(
        outcome: RawOutcome,
        overrides?: { usedExitFallback?: boolean }
      ): void {
        if (settled) return;
        settled = true;
        if (mainTimer !== null) { clearTimeout(mainTimer); mainTimer = null; }
        if (drainTimer !== null) { clearTimeout(drainTimer); drainTimer = null; }
        resolve({
          stdout,
          stderr,
          outcome,
          sawExit,
          sawClose,
          exitSignal,
          usedExitFallback:
            overrides?.usedExitFallback ?? usedExitFallback
        });
      }

      function finalizeFromExit(
        code: number,
        signal: string | null
      ): void {
        // Exit occurred — clear the main timeout immediately
        if (mainTimer !== null) { clearTimeout(mainTimer); mainTimer = null; }

        // Start a short drain grace period for stdio
        drainTimer = setTimeout(() => {
          drainTimer = null;
          usedExitFallback = true;
          finish({ kind: "close", exitCode: code });
        }, drainGraceMs);
      }

      const child = this.deps.spawn(executable, allArgs, {
        cwd: cwd,
        stdio: spawnOverrides?.stdio ?? ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: spawnOverrides?.windowsHide ?? true
      });

      if (spawnOverrides?.onSpawn) {
        spawnOverrides.onSpawn(child);
      }

      let timedOut = false;
      mainTimer = setTimeout(() => {
        mainTimer = null;
        timedOut = true;
        child.kill("SIGKILL");
        finish({ kind: "timeout" });
      }, limitMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (spawnOverrides?.rawStderrChunks) {
          spawnOverrides.rawStderrChunks.push(chunk);
        }
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (timedOut) return;
        finish({ kind: "spawn_error", message: err.message });
      });

      child.on("exit", (code: number | null, signal: string | null) => {
        if (timedOut) return;
        sawExit = true;
        exitCode = code;
        exitSignal = signal;
        finalizeFromExit(code ?? -1, signal);
      });

      child.on("close", (code: number | null) => {
        if (timedOut) return;
        sawClose = true;

        // Cancel drain timer — close arrived in time
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }

        // Prefer the exit code if we saw it
        const finalCode = exitCode ?? code ?? -1;
        finish({ kind: "close", exitCode: finalCode });
      });
    });

    return classifyProcessResult({
      ...result,
      startMs
    });
  }
}

// ── Process Result Classification ──────────────────────────────────────

interface RawProcessResult {
  stdout: string;
  stderr: string;
  outcome:
    | { kind: "close"; exitCode: number }
    | { kind: "timeout" }
    | { kind: "spawn_error"; message: string };
  sawExit: boolean;
  sawClose: boolean;
  exitSignal: string | null;
  usedExitFallback: boolean;
  startMs: number;
}

function classifyProcessResult(
  raw: RawProcessResult
): LeanCheckResult {
  const debug = {
    sawExit: raw.sawExit,
    sawClose: raw.sawClose,
    exitCode: raw.outcome.kind === "close"
      ? raw.outcome.exitCode
      : raw.outcome.kind === "timeout"
        ? -1
        : -1,
    exitSignal: raw.exitSignal ?? undefined,
    elapsedMs: Date.now() - raw.startMs,
    usedExitFallback: raw.usedExitFallback
  };

  if (raw.outcome.kind === "spawn_error") {
    return {
      status: "error",
      exitCode: -1,
      stdout: raw.stdout,
      stderr: raw.stderr,
      diagnostics: [
        {
          severity: "error",
          message:
            "Lean process failed to start: " +
            raw.outcome.message
        }
      ],
      debug
    };
  }

  if (raw.outcome.kind === "timeout") {
    return {
      status: "error",
      exitCode: -1,
      stdout: raw.stdout,
      stderr: raw.stderr,
      diagnostics: [
        {
          severity: "error",
          message: "Lean check timed out."
        }
      ],
      debug
    };
  }

  // kind === "close" — process started, ran, and exited
  const exitCode = raw.outcome.exitCode;

  if (exitCode === 0) {
    const diagnostics = parseLeanStructuredDiagnostics(
      [...raw.stdout.split("\n"), ...raw.stderr.split("\n")]
    );

    return {
      status: "statement_typechecked",
      exitCode: 0,
      stdout: raw.stdout,
      stderr: raw.stderr,
      diagnostics,
      debug
    };
  }

  const errDiagnostics = parseLeanStructuredDiagnostics(
    [...raw.stdout.split("\n"), ...raw.stderr.split("\n")]
  );

  if (errDiagnostics.length === 0) {
    const combined = (raw.stderr || raw.stdout).trim();
    errDiagnostics.push({
      severity: "error",
      message:
        `Process exited with code ${exitCode}.` +
        (combined !== ""
          ? "\n" + combined.slice(0, 2000)
          : "")
    });
  }

  return {
    status: "error",
    exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    diagnostics: errDiagnostics,
    debug
  };
}

// ── Structured Diagnostic Parser ───────────────────────────────────────

function parseLeanStructuredDiagnostics(
  lines: string[]
): LeanDiagnostic[] {
  const diagnostics: LeanDiagnostic[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      continue;
    }

    const match = trimmed.match(
      /^.*?\.lean:(\d+):(\d+):\s*(error|warning|info)\s*:\s*(.+)$/
    );

    if (match !== null && match[1] !== undefined &&
        match[2] !== undefined && match[3] !== undefined &&
        match[4] !== undefined) {
      diagnostics.push({
        severity: match[3] as LeanDiagnostic["severity"],
        message: match[4].trim(),
        line: parseInt(match[1], 10),
        column: parseInt(match[2], 10)
      });
    } else if (
      trimmed.startsWith("error") ||
      trimmed.includes(" error")
    ) {
      diagnostics.push({
        severity: "error",
        message: trimmed
      });
    }
  }

  return diagnostics;
}

// ── Environment Test ───────────────────────────────────────────────────

export interface LeanEnvironmentTestResult {
  ok: boolean;
  diagnostics: LeanDiagnostic[];
}

export async function testLeanEnvironment(
  runner: LeanRunner,
  timeoutSeconds?: number
): Promise<LeanEnvironmentTestResult> {
  const testCode = [
    "import Mathlib.Data.Real.Basic",
    "",
    "set_option autoImplicit false",
    "",
    "#check (∀ value : ℝ, value + 0 = value)"
  ].join("\n");

  const result = await runner.check({
    code: testCode,
    timeoutSeconds
  });

  return {
    ok: result.status === "statement_typechecked",
    diagnostics: result.diagnostics
  };
}

// ── WSL Command Ladder ──────────────────────────────────────────────────

function inspectStderrBytes(chunks: Buffer[]): {
  hex: string;
  looksUtf16LE: boolean;
} {
  if (chunks.length === 0) {
    return { hex: "", looksUtf16LE: false };
  }

  const combined = Buffer.concat(chunks);
  const sample = combined.subarray(0, Math.min(64, combined.length));

  const hex = Array.from(sample)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");

  // Heuristic: count interleaved NUL bytes.
  // In UTF-16LE-encoded ASCII text every other byte is 0x00.
  let evenNul = 0;
  let evenTotal = 0;
  let oddNul = 0;
  let oddTotal = 0;

  for (let i = 0; i < sample.length; i++) {
    if (i % 2 === 0) {
      evenTotal++;
      if (sample[i] === 0) evenNul++;
    } else {
      oddTotal++;
      if (sample[i] === 0) oddNul++;
    }
  }

  // Strong signal: one parity is mostly NUL, the other is mostly non-NUL.
  const looksUtf16LE =
    sample.length >= 4 &&
    ((evenNul >= evenTotal * 0.7 && oddNul <= oddTotal * 0.3) ||
     (oddNul >= oddTotal * 0.7 && evenNul <= evenTotal * 0.3));

  return { hex, looksUtf16LE };
}

function classifyLadderStatus(result: LeanCheckResult): {
  status: WslLadderResult["status"];
} {
  if (
    result.diagnostics.some((d) => d.message.includes("timed out"))
  ) {
    return { status: "timeout" };
  }
  if (
    result.diagnostics.some((d) =>
      d.message.includes("failed to start")
    )
  ) {
    return { status: "spawn_error" };
  }
  if (result.status === "statement_typechecked") {
    return { status: "success" };
  }
  return { status: "exit_error" };
}

function buildLadderInterpretation(
  results: WslLadderResult[]
): string {
  const byPrefix = (
    prefix: string
  ): WslLadderResult[] =>
    results.filter(
      (r) =>
        r.label.startsWith(prefix) && r.status === "success"
    );

  const hostOk = byPrefix("HOST-");
  const distroOk = byPrefix("DISTRO-");
  const lakeOk = byPrefix("LAKE-");
  const leanOk = results.filter(
    (r) => r.label === "LEAN-1" && r.status === "success"
  );

  if (hostOk.length === 0) {
    return (
      "Even HOST commands fail — failure is the " +
      "Electron → wsl.exe process integration itself."
    );
  }
  if (distroOk.length === 0) {
    return (
      "HOST commands succeed, DISTRO commands fail — " +
      "failure is distro/WSL launch from Electron."
    );
  }
  if (lakeOk.length === 0) {
    return (
      "DISTRO commands succeed, LAKE commands fail — " +
      "failure begins at lake/project execution."
    );
  }
  if (leanOk.length === 0) {
    return (
      "LAKE commands succeed, LEAN fails — failure is " +
      "Lean/file/project-specific."
    );
  }
  return (
    "All commands succeed — the previous timeout may " +
    "have been transient."
  );
}

export async function runWslCommandLadder(
  config: LeanRunnerConfig,
  deps?: Partial<LeanRunnerDeps>
): Promise<WslLadderResults> {
  const distro = config.wslDistribution || "";
  const project = config.wslProjectRoot || "";
  const exe = config.wslExecutable || "wsl.exe";
  const leanExe = config.executable || "lake";
  const leanArgs = config.args ?? ["env", "lean"];

  // Cap per-command timeout short so the full ladder is fast.
  // Tests can pass an even smaller value.
  const ladderTimeout = Math.min(
    config.timeoutSeconds ?? 30,
    5
  );

  // Build the distro prefix once.
  const distroPrefix: string[] =
    distro !== "" ? ["-d", distro] : [];

  const testCode = [
    "import Mathlib.Data.Real.Basic",
    "",
    "set_option autoImplicit false",
    "",
    "#check (∀ value : ℝ, value + 0 = value)"
  ].join("\n");

  // We need a runner that lives long enough for all rungs.
  const diagConfig: LeanRunnerConfig = {
    ...config,
    mode: "wsl",
    timeoutSeconds: ladderTimeout
  };
  const runner = new SpawnLeanRunner(diagConfig, deps);

  const rungs: Array<{
    label: string;
    command: string;
    executable: string;
    args: string[];
    needsTempFile: boolean;
  }> = [
    {
      label: "HOST-1",
      command: `${exe} --status`,
      executable: exe,
      args: ["--status"],
      needsTempFile: false
    },
    {
      label: "HOST-2",
      command: `${exe} -l -q`,
      executable: exe,
      args: ["-l", "-q"],
      needsTempFile: false
    },
    {
      label: "DISTRO-1",
      command: `${exe} -d ${distro} -- /bin/true`,
      executable: exe,
      args: [...distroPrefix, "--", "/bin/true"],
      needsTempFile: false
    },
    {
      label: "DISTRO-2",
      command: `${exe} -d ${distro} -- /usr/bin/printf __LAIN_WSL_OK__`,
      executable: exe,
      args: [
        ...distroPrefix,
        "--",
        "/usr/bin/printf",
        "__LAIN_WSL_OK__"
      ],
      needsTempFile: false
    },
    {
      label: "DISTRO-3",
      command: `${exe} -d ${distro} --cd ${project} -- /bin/pwd`,
      executable: exe,
      args: [
        ...distroPrefix,
        "--cd",
        project,
        "--",
        "/bin/pwd"
      ],
      needsTempFile: false
    },
    {
      label: "LAKE-1",
      command: `${exe} -d ${distro} --cd ${project} -- ${leanExe} --version`,
      executable: exe,
      args: [
        ...distroPrefix,
        "--cd",
        project,
        "--",
        leanExe,
        "--version"
      ],
      needsTempFile: false
    },
    {
      label: "LAKE-2",
      command: `${exe} -d ${distro} --cd ${project} -- ${leanExe} ${leanArgs.join(" ")} --version`,
      executable: exe,
      args: [
        ...distroPrefix,
        "--cd",
        project,
        "--",
        leanExe,
        ...leanArgs,
        "--version"
      ],
      needsTempFile: false
    },
    {
      label: "LEAN-1",
      command: `${exe} -d ${distro} --cd ${project} -- ${leanExe} ${leanArgs.join(" ")} <temp>`,
      executable: "",
      args: [],
      needsTempFile: true
    }
  ];

  const results: WslLadderResult[] = [];

  for (const rung of rungs) {
    let result: LeanCheckResult;

    if (rung.needsTempFile) {
      // LEAN-1: use diagnosticWslCheck which writes a temp file.
      result = await runner.diagnosticWslCheck(
        { code: testCode, timeoutSeconds: ladderTimeout },
        {}
      );
    } else {
      result = await runner.runDiagnosticCommand(
        rung.executable,
        rung.args,
        ladderTimeout,
        {}
      );
    }

    const { status } = classifyLadderStatus(result);

    results.push({
      label: rung.label,
      command: rung.command,
      status,
      exitCode: result.exitCode,
      elapsedMs: result.debug?.elapsedMs ?? 0,
      sawExit: result.debug?.sawExit ?? false,
      sawClose: result.debug?.sawClose ?? false,
      stdout: result.stdout,
      stderr: result.stderr,
      stderrHexFirstBytes: "",
      stderrLooksUtf16LE: false
    });
  }

  // ── Second pass: re-run every rung that produced stderr, this time
  //    capturing raw bytes for encoding inspection. ────────────────────
  for (let i = 0; i < rungs.length; i++) {
    const entry = results[i];
    if (entry === undefined) continue;
    if (entry.stderr.trim() === "") continue;

    const rung = rungs[i];
    if (rung === undefined) continue;

    const rawChunks: Buffer[] = [];
    let rawResult: LeanCheckResult;

    if (rung.needsTempFile) {
      rawResult = await runner.diagnosticWslCheck(
        { code: testCode, timeoutSeconds: ladderTimeout },
        { rawStderrChunks: rawChunks }
      );
    } else {
      rawResult = await runner.runDiagnosticCommand(
        rung.executable,
        rung.args,
        ladderTimeout,
        { rawStderrChunks: rawChunks }
      );
    }

    const { hex, looksUtf16LE } = inspectStderrBytes(rawChunks);
    results[i] = {
      ...entry,
      stderrHexFirstBytes: hex,
      stderrLooksUtf16LE: looksUtf16LE
    };
  }

  const interpretation = buildLadderInterpretation(results);

  return { results, interpretation };
}
