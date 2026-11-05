import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shellLauncher } from "../client/launch.ts";

// A real controlling PTY checks interactivity, login startup, stdin, output, and exit
// behavior. The account database seam selects each installed shell without editing users.
const ptyDriver = `
import errno, os, pty, select, signal, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execve('/bin/sh', ['/bin/sh', '-c', sys.argv[1], 'paseo-client-command', sys.argv[2]], os.environ)
output = b''
deadline = time.monotonic() + 15
sent = False
while time.monotonic() < deadline:
    if not select.select([fd], [], [], 0.1)[0]:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not data:
        break
    output += data
    if b'Press Enter to close.' in output and not sent:
        os.write(fd, b'\\n')
        sent = True
else:
    os.kill(pid, signal.SIGKILL)
    raise RuntimeError('PTY timed out: ' + output.decode(errors='replace'))
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(output)
sys.exit(os.waitstatus_to_exitcode(status))
`;

for (const shell of ["bash", "zsh", "fish"]) {
  const found = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "find-shell", shell], { encoding: "utf8" });
  const executable = found.status === 0 ? found.stdout.trim() : null;
  test(`${shell}: approved command runs in a login interactive shell with a real PTY`, { skip: !executable }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `client-command-${shell}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    await mkdir(bin);
    await mkdir(join(directory, ".config", "fish"), { recursive: true });
    await writeFile(join(bin, "getent"), `#!/bin/sh\nprintf '%s\\n' 'test:x:1000:1000::${directory}:${executable}'\n`, { mode: 0o755 });
    const functionDefinition = shell === "fish"
      ? "function paseo_probe; printf 'STARTUP_LOADED\\n'; end\n"
      : "paseo_probe() { printf 'STARTUP_LOADED\\n'; }\n";
    await writeFile(join(directory, shell === "bash" ? ".bash_profile" : shell === "zsh" ? ".zshrc" : ".config/fish/config.fish"), functionDefinition);
    const checks = shell === "fish"
      ? "status is-login; and status is-interactive; and test -t 0; and test -t 1; and printf 'LOGIN_INTERACTIVE_TTY\\n'"
      : shell === "bash"
        ? "shopt -q login_shell && [[ $- == *i* ]] && test -t 0 && test -t 1 && printf 'LOGIN_INTERACTIVE_TTY\\n'"
        : "[[ -o login && -o interactive ]] && test -t 0 && test -t 1 && printf 'LOGIN_INTERACTIVE_TTY\\n'";
    const result = spawnSync("python3", ["-c", ptyDriver, shellLauncher, `${checks}\npaseo_probe\nprintf '%s\\n' 'literal $() backticks \` spaces'\nexit 7`], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), ZDOTDIR: directory, PATH: `${bin}:${process.env.PATH}`, TERM: "xterm-256color" },
    });
    assert.equal(result.status, 7, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
    assert.match(result.stdout, /LOGIN_INTERACTIVE_TTY/);
    assert.match(result.stdout, /STARTUP_LOADED/);
    assert.ok(result.stdout.includes("literal $() backticks ` spaces"));
    assert.match(result.stdout, /Command exited with status 7/);
  });
}
