import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeWaylandCursorPoint, type WaylandOutput } from "./waylandCoordinates";
import {
	consumeWaylandHelperChunk,
	mergeWaylandOutputs,
	type WaylandHelperEvent,
} from "./waylandProtocol";

/**
 * Live diagnostic for a real KDE Plasma / KWin Wayland session.
 *
 * Skipped everywhere by default — unit tests must never need a compositor.
 * Run it on the KDE machine with:
 *
 *   RECORDLY_LIVE_WAYLAND_TEST=1 npx vitest --run electron/ipc/cursor/waylandKdeLive.test.ts
 *
 * then move the mouse and click for the ~12 s the test is collecting.
 */
const isEnabled = process.env.RECORDLY_LIVE_WAYLAND_TEST === "1";
const COLLECT_MS = Number(process.env.RECORDLY_LIVE_WAYLAND_TEST_MS ?? 12000);

const projectRoot = path.resolve(__dirname, "..", "..", "..");
const helperCandidates = [
	path.join(projectRoot, "electron", "native", "bin", "linux-x64", "recordly-wayland-cursor"),
	path.join(
		projectRoot,
		"electron",
		"native",
		"wayland-cursor",
		"build",
		"recordly-wayland-cursor",
	),
];
const kwinScriptPath = path.join(
	projectRoot,
	"electron",
	"native",
	"wayland-cursor",
	"kwin",
	"recordly-cursor-bridge.js",
);

describe.skipIf(!isEnabled)("live KDE Wayland cursor helper", () => {
	it(
		"streams changing absolute cursor positions and paired button events",
		async () => {
			const helperPath = helperCandidates.find((candidate) => existsSync(candidate));
			expect(
				helperPath,
				"build the helper first: npm run build:wayland-cursor",
			).toBeDefined();

			const helper = spawn(helperPath as string, ["--kwin-script", kwinScriptPath], {
				stdio: ["pipe", "pipe", "pipe"],
			});

			const events: WaylandHelperEvent[] = [];
			let buffer = "";
			let outputs: WaylandOutput[] = [];

			helper.stdout.on("data", (chunk: Buffer) => {
				const parsed = consumeWaylandHelperChunk(buffer, chunk.toString());
				buffer = parsed.buffer;
				for (const event of parsed.events) {
					events.push(event);
					if (event.type === "output") {
						outputs = mergeWaylandOutputs(outputs, event);
					}
				}
			});

			console.log(`[live] collecting for ${COLLECT_MS}ms — move the mouse and click now.`);
			await new Promise((resolve) => setTimeout(resolve, COLLECT_MS));

			helper.stdin.write("stop\n");
			helper.stdin.end();
			await new Promise((resolve) => helper.once("close", resolve));

			const errors = events.filter((event) => event.type === "error");
			const moves = events.filter((event) => event.type === "move");
			const buttons = events.filter((event) => event.type === "button");
			const uniquePositions = new Set(moves.map((move) => `${move.x},${move.y}`));

			const normalized = new Set(
				moves.map((move) => {
					const point = normalizeWaylandCursorPoint({ point: move, outputs });
					return `${point.cx.toFixed(4)},${point.cy.toFixed(4)}`;
				}),
			);

			console.log(
				JSON.stringify(
					{
						outputs,
						moves: moves.length,
						uniquePositions: uniquePositions.size,
						uniqueNormalized: normalized.size,
						buttonPresses: buttons.filter((button) => button.pressed).length,
						buttonReleases: buttons.filter((button) => !button.pressed).length,
						errors: errors.map((error) => error.message),
					},
					null,
					2,
				),
			);

			expect(errors).toEqual([]);
			expect(outputs.length).toBeGreaterThan(0);
			expect(uniquePositions.size).toBeGreaterThan(50);
			expect(normalized.size).toBeGreaterThan(50);
			expect(buttons.filter((button) => button.pressed).length).toBe(
				buttons.filter((button) => !button.pressed).length,
			);
		},
		COLLECT_MS + 15000,
	);
});
