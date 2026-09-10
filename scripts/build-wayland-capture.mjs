import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const sourceDir = path.join(projectRoot, "electron", "native", "wayland-capture");
const buildDir = path.join(sourceDir, "build");
const binaryName = "recordly-wayland-capture";
const bundledDir = path.join(
	projectRoot,
	"electron",
	"native",
	"bin",
	process.arch === "arm64" ? "linux-arm64" : "linux-x64",
);
const bundledBinaryPath = path.join(bundledDir, binaryName);

const prefix = "[build-wayland-capture]";

if (process.platform !== "linux") {
	console.log(`${prefix} Skipping: host platform is not Linux.`);
	process.exit(0);
}

function run(command, args, options = {}) {
	execFileSync(command, args, { stdio: "inherit", timeout: 300000, ...options });
}

/** The helper links sd-bus for the portal and GStreamer for acquisition. */
const requiredModules = ["libsystemd", "gstreamer-1.0", "gstreamer-app-1.0"];

function missingHeaders() {
	return requiredModules.filter((module) => {
		try {
			execFileSync("pkg-config", ["--exists", module], { stdio: "ignore" });
			return false;
		} catch {
			return true;
		}
	});
}

function reuseBundledBinary(reason) {
	if (!existsSync(bundledBinaryPath)) {
		console.error(`${prefix} ${reason}`);
		console.error(
			`${prefix} Install the build dependencies on Fedora with:\n` +
				`${prefix}   sudo dnf install cmake gcc-c++ systemd-devel gstreamer1-devel gstreamer1-plugins-base-devel`,
		);
		process.exit(1);
	}

	console.log(`${prefix} ${reason} Using the bundled helper: ${bundledBinaryPath}`);
	process.exit(0);
}

try {
	execFileSync("cmake", ["--version"], { stdio: "ignore" });
} catch {
	reuseBundledBinary("CMake is not installed.");
}

const missing = missingHeaders();
if (missing.length > 0) {
	reuseBundledBinary(`Development headers are missing: ${missing.join(", ")}.`);
}

console.log(`${prefix} Configuring CMake...`);
run("cmake", ["-S", sourceDir, "-B", buildDir, "-DCMAKE_BUILD_TYPE=Release"]);

console.log(`${prefix} Building...`);
run("cmake", ["--build", buildDir, "--config", "Release"]);

const builtBinaryPath = path.join(buildDir, binaryName);
if (!existsSync(builtBinaryPath)) {
	console.error(`${prefix} Expected binary not found at ${builtBinaryPath}`);
	process.exit(1);
}

mkdirSync(bundledDir, { recursive: true });
copyFileSync(builtBinaryPath, bundledBinaryPath);
console.log(`${prefix} Staged bundled helper: ${bundledBinaryPath}`);
