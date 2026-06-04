import { spawnSync } from "node:child_process";

const result = spawnSync("pi", ["-e", ".", "--no-session", "-p", "/gaud-status"], {
	cwd: process.cwd(),
	encoding: "utf8",
	stdio: "pipe",
});

if (result.error) throw result.error;
if (result.status !== 0) {
	console.error(result.stdout);
	console.error(result.stderr);
	process.exit(result.status ?? 1);
}

console.log("Smoke OK: package loads and /gaud-status command is handled.");
