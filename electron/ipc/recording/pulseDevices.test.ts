import { describe, expect, it } from "vitest";
import { matchPulseSourceByLabel, parsePulseSources, resolvePulseSourceName } from "./pulseDevices";

// Trimmed from `pactl -f json list sources` on Fedora 44 / PipeWire.
const REAL_OUTPUT = JSON.stringify([
	{ name: "effect_output.gtcrn", description: "Warm Broadcast Mic (Deep & Velvet Podcast)" },
	{ name: "echo_cancel_source", description: "AEC Cleaned Microphone (Echo-Free)" },
	{
		name: "alsa_output.pci-0000_63_00.6.analog-stereo.monitor",
		description: "Monitor of Ryzen HD Audio Controller Analog Stereo",
	},
	{
		name: "alsa_input.pci-0000_63_00.6.analog-stereo",
		description: "Ryzen HD Audio Controller Analog Stereo",
	},
]);

describe("parsePulseSources", () => {
	it("reads name and description pairs", () => {
		const sources = parsePulseSources(REAL_OUTPUT);
		expect(sources).toHaveLength(4);
		expect(sources[3]).toEqual({
			name: "alsa_input.pci-0000_63_00.6.analog-stereo",
			description: "Ryzen HD Audio Controller Analog Stereo",
		});
	});

	it("returns nothing for junk rather than throwing", () => {
		expect(parsePulseSources("not json")).toEqual([]);
		expect(parsePulseSources("{}")).toEqual([]);
		expect(parsePulseSources("[{}]")).toEqual([]);
	});
});

describe("matchPulseSourceByLabel", () => {
	const sources = parsePulseSources(REAL_OUTPUT);

	it("matches the browser label to the source description", () => {
		expect(matchPulseSourceByLabel(sources, "Ryzen HD Audio Controller Analog Stereo")).toBe(
			"alsa_input.pci-0000_63_00.6.analog-stereo",
		);
	});

	it("ignores case and surrounding whitespace", () => {
		expect(matchPulseSourceByLabel(sources, "  aec cleaned microphone (echo-free) ")).toBe(
			"echo_cancel_source",
		);
	});

	it("refuses a label it cannot match exactly", () => {
		// Substring matching would pair "Monitor of Ryzen HD Audio" with the
		// "Ryzen HD Audio" input and record the speakers instead of the mic, so
		// anything short of an exact match falls back to the browser path.
		expect(
			matchPulseSourceByLabel(sources, "Default - Ryzen HD Audio Controller Analog Stereo"),
		).toBeNull();
	});

	it("never returns a monitor, which is an output loopback and not a microphone", () => {
		expect(
			matchPulseSourceByLabel(sources, "Monitor of Ryzen HD Audio Controller Analog Stereo"),
		).toBeNull();
	});

	it("returns null when nothing matches", () => {
		expect(matchPulseSourceByLabel(sources, "Some USB Headset")).toBeNull();
		expect(matchPulseSourceByLabel(sources, "")).toBeNull();
		expect(matchPulseSourceByLabel(sources, undefined)).toBeNull();
	});
});

describe("resolvePulseSourceName", () => {
	it("resolves through the injected lister", async () => {
		await expect(
			resolvePulseSourceName("AEC Cleaned Microphone (Echo-Free)", {
				listSources: async () => REAL_OUTPUT,
			}),
		).resolves.toBe("echo_cancel_source");
	});

	it("returns null when pactl is unavailable instead of throwing", async () => {
		await expect(
			resolvePulseSourceName("anything", {
				listSources: async () => {
					throw new Error("ENOENT");
				},
			}),
		).resolves.toBeNull();
	});

	it("returns null without a label", async () => {
		await expect(resolvePulseSourceName(undefined)).resolves.toBeNull();
		await expect(resolvePulseSourceName("   ")).resolves.toBeNull();
	});
});
