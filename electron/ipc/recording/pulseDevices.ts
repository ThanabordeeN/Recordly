import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Maps a browser microphone selection onto a PulseAudio source name.
 *
 * Recordly picks microphones by `MediaDeviceInfo.deviceId`, which is a
 * per-origin hash that means nothing outside Chromium. The capture helper
 * records through PulseAudio and needs a source *name*. The one thing both
 * sides share is the human-readable label: Chromium reports the PulseAudio
 * source description as the device label, so the label is the join key.
 *
 * A failure to match is deliberately not papered over. Recording the default
 * input when the user asked for a specific one would silently capture the wrong
 * microphone, so callers fall back to the browser path instead.
 */

export type PulseSource = {
	name: string;
	description: string;
};

export function parsePulseSources(raw: string): PulseSource[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) {
		return [];
	}

	return parsed
		.map((entry) => {
			const source = entry as { name?: unknown; description?: unknown };
			return {
				name: typeof source.name === "string" ? source.name : "",
				description: typeof source.description === "string" ? source.description : "",
			};
		})
		.filter((source) => source.name.length > 0);
}

function normalize(value: string) {
	return value.trim().toLowerCase();
}

/**
 * Finds the source whose description matches the browser's device label.
 *
 * Monitors are excluded: they are loopbacks of an output, never a microphone,
 * and Chromium never offers one as an input device.
 */
export function matchPulseSourceByLabel(
	sources: PulseSource[],
	label: string | undefined,
): string | null {
	const wanted = normalize(label ?? "");
	if (!wanted) {
		return null;
	}

	const inputs = sources.filter((source) => !source.name.endsWith(".monitor"));

	// Exact match only. Substring matching looks helpful until it pairs
	// "Monitor of Ryzen HD Audio" with the "Ryzen HD Audio" input and records
	// the speakers instead of the microphone. An unmatched label falls back to
	// the browser path, which is always safe.
	const exact = inputs.find((source) => normalize(source.description) === wanted);
	return exact?.name ?? null;
}

export async function resolvePulseSourceName(
	label: string | undefined,
	options?: { listSources?: () => Promise<string> },
): Promise<string | null> {
	if (!label?.trim()) {
		return null;
	}

	try {
		const raw = options?.listSources
			? await options.listSources()
			: (await execFileAsync("pactl", ["-f", "json", "list", "sources"], { timeout: 5000 }))
					.stdout;
		return matchPulseSourceByLabel(parsePulseSources(raw), label);
	} catch {
		// pactl missing or failing is not an error worth surfacing: the caller
		// simply keeps using the browser path.
		return null;
	}
}
