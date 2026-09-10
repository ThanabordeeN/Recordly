import { describe, expect, it, vi } from "vitest";
import { startWaylandCaptureWithBoundary } from "./waylandCaptureStartup";

describe("Wayland companion startup boundary", () => {
	it("subscribes before capture, preserves the first epoch and ignores duplicate/foreign events", async () => {
		const unsubscribe = vi.fn(); const onStarted = vi.fn();
		let listener: (event: { fileName: string; startedAtMs: number }) => void = () => { throw new Error("not subscribed"); };
		const result = await startWaylandCaptureWithBoundary({
			fileName: "a.mp4", cancelled: () => false, onStarted,
			subscribe: (callback) => { listener = callback; return unsubscribe; },
			start: async () => {
				listener({ fileName: "old.mp4", startedAtMs: 900 });
				listener({ fileName: "a.mp4", startedAtMs: 1000 });
				expect(onStarted).toHaveBeenCalledExactlyOnceWith(1000);
				listener({ fileName: "a.mp4", startedAtMs: 1500 });
				return { success: true, startedAtMs: 1000 };
			},
		});
		expect(result.success).toBe(true); expect(onStarted).toHaveBeenCalledTimes(1); expect(unsubscribe).toHaveBeenCalledOnce();
	});
	it("never starts companions after cancellation and always unsubscribes", async () => {
		const onStarted = vi.fn(); const unsubscribe = vi.fn();
		await startWaylandCaptureWithBoundary({ fileName: "a.mp4", cancelled: () => true, onStarted, subscribe: (callback) => { callback({ fileName: "a.mp4", startedAtMs: 1000 }); return unsubscribe; }, start: async () => ({ success: false }) });
		expect(onStarted).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce();
	});
	it("does not silently substitute encoded-ready time when the first sample event is missing", async () => {
		const unsubscribe = vi.fn();
		await expect(startWaylandCaptureWithBoundary({ fileName: "a.mp4", cancelled: () => false, onStarted: vi.fn(), subscribe: () => unsubscribe, start: async () => ({ success: true, startedAtMs: 1000 }) })).rejects.toThrow("first-sample");
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
