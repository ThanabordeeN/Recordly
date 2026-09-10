export type WaylandStartupBoundary = { fileName: string; startedAtMs: number };

/** Keep first-sample startup separate from slower encoder confirmation. */
export async function startWaylandCaptureWithBoundary<T extends { success: boolean; startedAtMs?: number }>(options: {
	fileName: string;
	subscribe: (callback: (event: WaylandStartupBoundary) => void) => () => void;
	start: () => Promise<T>;
	cancelled: () => boolean;
	onStarted: (startedAtMs: number) => void;
}): Promise<T> {
	let epoch: number | undefined;
	let boundaryError: unknown;
	const unsubscribe = options.subscribe((event) => {
		if (options.cancelled() || epoch !== undefined || event.fileName !== options.fileName || !Number.isSafeInteger(event.startedAtMs) || event.startedAtMs < 0) return;
		epoch = event.startedAtMs;
		try { options.onStarted(epoch); } catch (error) { boundaryError = error; }
	});
	try {
		const result = await options.start();
		if (boundaryError) throw boundaryError;
		if (result.success && !options.cancelled() && (epoch === undefined || result.startedAtMs !== epoch)) {
			throw new Error("Wayland first-sample boundary was missing or changed during startup");
		}
		return result;
	} finally {
		unsubscribe();
	}
}
