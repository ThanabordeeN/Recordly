import fs from "node:fs";
import path from "node:path";
import {
	type CursorBackendResolution,
	formatCursorBackendStartupLogs,
	normalizeBuildVariant,
	type RecordlyBuildVariant,
	resolveCursorBackend,
} from "./ipc/cursor/backend";

/** Marker file the dedicated Wayland artifact ships in its resources directory. */
export const BUILD_VARIANT_RESOURCE_NAME = "recordly-build-variant.json";

/**
 * Reads the build variant stamped into the packaged artifact.
 *
 * The dedicated Wayland AppImage carries `recordly-build-variant.json` in its
 * resources directory, so the flag travels with the artifact rather than with
 * the source tree.  (A resource file rather than electron-builder's
 * `extraMetadata`, which rewrites the source package.json in place and strips
 * its scripts.)  In a source checkout the env override exercises the same path.
 */
export function readBuildVariant({
	resourcesPath,
	env = process.env,
	readFile = (target: string) => fs.readFileSync(target, "utf-8"),
}: {
	resourcesPath: string | undefined;
	env?: NodeJS.ProcessEnv;
	readFile?: (target: string) => string;
}): RecordlyBuildVariant {
	const override = normalizeBuildVariant(env.RECORDLY_BUILD_VARIANT?.trim());
	if (override !== "default") {
		return override;
	}

	if (!resourcesPath) {
		return "default";
	}

	try {
		const marker = JSON.parse(
			readFile(path.join(resourcesPath, BUILD_VARIANT_RESOURCE_NAME)),
		) as {
			recordlyBuildVariant?: unknown;
		};
		return normalizeBuildVariant(marker.recordlyBuildVariant);
	} catch {
		return "default";
	}
}

export function resolveStartupCursorBackend({
	resourcesPath,
	env = process.env,
	platform = process.platform,
	isWaylandHelperAvailable,
	readFile,
}: {
	resourcesPath: string | undefined;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	isWaylandHelperAvailable: boolean;
	readFile?: (target: string) => string;
}): CursorBackendResolution {
	return resolveCursorBackend({
		platform,
		env,
		buildVariant: readBuildVariant({ resourcesPath, env, readFile }),
		isWaylandHelperAvailable,
	});
}

export { formatCursorBackendStartupLogs };
