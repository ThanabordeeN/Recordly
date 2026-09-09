/**
 * Coordinate mapping for the KDE Wayland cursor backend.
 *
 * KWin reports the pointer in its own *global logical* coordinate space: the
 * origin is the top-left of the union of all outputs, each output sits at its
 * configured logical position, and an output's logical size is its mode size
 * divided by its (possibly fractional) scale.
 *
 * Electron reports displays in DIP with a `scaleFactor`.  On KWin the two
 * spaces line up, but Chromium rounds fractional scales oddly — a 1.75 output
 * is reported as `scaleFactor: 1.7496962547302246` — so dividing a KWin point
 * by `scaleFactor` (what the legacy Linux path did with `primarySf`) throws the
 * cursor across the screen.
 *
 * Everything here therefore stays inside KWin's space: we pick the KWin output
 * that corresponds to the captured Electron display and normalize the pointer
 * against *that output's* logical rect.  The result is scale-independent, so
 * HiDPI, fractional scaling, and negative monitor origins all fall out for
 * free.
 */

export type WaylandOutput = {
	index: number;
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
	scale: number;
};

export type WaylandPoint = {
	x: number;
	y: number;
};

export type NormalizedRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type DisplayLike = {
	id: number;
	label?: string;
	bounds: NormalizedRect;
	scaleFactor?: number;
};

export function clampUnit(value: number): number {
	if (!Number.isFinite(value)) {
		return 0.5;
	}

	return Math.min(1, Math.max(0, value));
}

function rectArea(rect: NormalizedRect): number {
	return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function intersectionArea(left: NormalizedRect, right: NormalizedRect): number {
	const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
	const height =
		Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);

	if (width <= 0 || height <= 0) {
		return 0;
	}

	return width * height;
}

function outputRect(output: WaylandOutput): NormalizedRect {
	return { x: output.x, y: output.y, width: output.width, height: output.height };
}

function sortByLayout<T>(items: T[], toRect: (item: T) => NormalizedRect): T[] {
	return [...items].sort((left, right) => {
		const a = toRect(left);
		const b = toRect(right);
		return a.x - b.x || a.y - b.y;
	});
}

/**
 * Pick the KWin output that corresponds to an Electron display.
 *
 * Priority, most to least trustworthy:
 *   1. only one output — nothing to disambiguate;
 *   2. identical logical rect (the normal KDE case: KWin logical == Electron DIP);
 *   3. largest overlap between the two rects (tolerates rounding);
 *   4. matching output name / display label;
 *   5. same left-to-right position in an equally sized layout.
 */
export function matchWaylandOutputForDisplay({
	outputs,
	display,
	displays = [],
}: {
	outputs: WaylandOutput[];
	display: DisplayLike | null | undefined;
	displays?: DisplayLike[];
}): WaylandOutput | null {
	if (outputs.length === 0) {
		return null;
	}

	if (outputs.length === 1) {
		return outputs[0];
	}

	if (!display) {
		return null;
	}

	const bounds = display.bounds;

	const exact = outputs.find(
		(output) =>
			output.x === bounds.x &&
			output.y === bounds.y &&
			output.width === bounds.width &&
			output.height === bounds.height,
	);
	if (exact) {
		return exact;
	}

	let bestOverlap: { output: WaylandOutput; area: number } | null = null;
	for (const output of outputs) {
		const area = intersectionArea(outputRect(output), bounds);
		if (area > 0 && (!bestOverlap || area > bestOverlap.area)) {
			bestOverlap = { output, area };
		}
	}
	// Require a meaningful overlap so two adjacent monitors sharing an edge
	// cannot be confused with each other.
	if (bestOverlap && bestOverlap.area >= rectArea(bounds) * 0.5) {
		return bestOverlap.output;
	}

	const label = display.label?.trim().toLowerCase();
	if (label) {
		const named = outputs.find((output) => output.name.trim().toLowerCase() === label);
		if (named) {
			return named;
		}
	}

	if (displays.length === outputs.length && displays.length > 0) {
		const orderedDisplays = sortByLayout(displays, (item) => item.bounds);
		const orderedOutputs = sortByLayout(outputs, outputRect);
		const position = orderedDisplays.findIndex((item) => item.id === display.id);
		if (position >= 0) {
			return orderedOutputs[position];
		}
	}

	return null;
}

/** The output whose logical rect contains the point, else the nearest one. */
export function findWaylandOutputForPoint(
	outputs: WaylandOutput[],
	point: WaylandPoint,
): WaylandOutput | null {
	if (outputs.length === 0) {
		return null;
	}

	const containing = outputs.find(
		(output) =>
			point.x >= output.x &&
			point.x < output.x + output.width &&
			point.y >= output.y &&
			point.y < output.y + output.height,
	);
	if (containing) {
		return containing;
	}

	let nearest: { output: WaylandOutput; distance: number } | null = null;
	for (const output of outputs) {
		const dx = Math.max(output.x - point.x, 0, point.x - (output.x + output.width));
		const dy = Math.max(output.y - point.y, 0, point.y - (output.y + output.height));
		const distance = Math.hypot(dx, dy);
		if (!nearest || distance < nearest.distance) {
			nearest = { output, distance };
		}
	}

	return nearest?.output ?? null;
}

/**
 * Normalize a KWin logical point to [0,1] inside a rect expressed in the same
 * logical space.  Scale never enters the calculation, which is what makes this
 * correct for 100%, 125%, 150%, and fractional scaling alike.
 */
export function normalizePointInRect(point: WaylandPoint, rect: NormalizedRect) {
	const width = Math.max(1, rect.width);
	const height = Math.max(1, rect.height);

	return {
		cx: clampUnit((point.x - rect.x) / width),
		cy: clampUnit((point.y - rect.y) / height),
	};
}

/**
 * Full mapping used by cursor telemetry: KWin logical point plus the captured
 * Electron display, out to Recordly's `{ cx, cy }` in [0,1].
 *
 * When the captured display cannot be matched to a KWin output (unusual multi
 * monitor layouts, or a portal capture whose display we never learned), the
 * point is normalized against the output the cursor is actually on.  That keeps
 * Auto Zoom pointing at real screen content instead of collapsing to 0.5/0.5.
 */
export function normalizeWaylandCursorPoint({
	point,
	outputs,
	display,
	displays = [],
}: {
	point: WaylandPoint;
	outputs: WaylandOutput[];
	display?: DisplayLike | null;
	displays?: DisplayLike[];
}): { cx: number; cy: number; output: WaylandOutput | null } {
	const matched =
		matchWaylandOutputForDisplay({ outputs, display, displays }) ??
		findWaylandOutputForPoint(outputs, point);

	if (matched) {
		return { ...normalizePointInRect(point, outputRect(matched)), output: matched };
	}

	// No KWin output layout yet (the bridge script reports it a beat after the
	// first cursor sample).  Electron DIP bounds equal KWin logical bounds on
	// KWin, so the display rect is the best available approximation.
	if (display) {
		return { ...normalizePointInRect(point, display.bounds), output: null };
	}

	return { cx: 0.5, cy: 0.5, output: null };
}

export function parseWaylandOutputScale(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
