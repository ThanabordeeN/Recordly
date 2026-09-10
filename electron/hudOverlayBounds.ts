export interface HudOverlayWorkArea {
	x: number;
	y: number;
	width: number;
	height: number;
}

const NON_PASSTHROUGH_HUD_WIDTH_DIP = 860;
const NON_PASSTHROUGH_HUD_COMPACT_HEIGHT_DIP = 160;
const NON_PASSTHROUGH_HUD_EXPANDED_HEIGHT_DIP = 540;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function getHudOverlayWindowBounds(
	workArea: HudOverlayWorkArea,
	mousePassthroughSupported: boolean,
	fallbackExpanded = false,
	fallbackWidth = NON_PASSTHROUGH_HUD_WIDTH_DIP,
): HudOverlayWorkArea {
	if (mousePassthroughSupported) {
		return { ...workArea };
	}

	const width = Math.min(workArea.width, Math.max(1, fallbackWidth));
	const height = Math.min(
		workArea.height,
		fallbackExpanded
			? NON_PASSTHROUGH_HUD_EXPANDED_HEIGHT_DIP
			: NON_PASSTHROUGH_HUD_COMPACT_HEIGHT_DIP,
	);

	return {
		x: Math.round(workArea.x + (workArea.width - width) / 2),
		y: Math.round(workArea.y + workArea.height - height),
		width,
		height,
	};
}

export function shouldExpandHudOverlayFallback({
	fallbackExpanded,
	recordingActive,
	webcamPreviewVisible,
}: {
	fallbackExpanded: boolean;
	recordingActive: boolean;
	webcamPreviewVisible: boolean;
}): boolean {
	return fallbackExpanded || (recordingActive && webcamPreviewVisible);
}

export function resizeHudOverlayFallbackBounds(
	workArea: HudOverlayWorkArea,
	currentBounds: HudOverlayWorkArea,
	fallbackExpanded: boolean,
	fallbackWidth = NON_PASSTHROUGH_HUD_WIDTH_DIP,
): HudOverlayWorkArea {
	const nextBounds = getHudOverlayWindowBounds(
		workArea,
		false,
		fallbackExpanded,
		fallbackWidth,
	);
	const maxX = workArea.x + workArea.width - nextBounds.width;
	const maxY = workArea.y + workArea.height - nextBounds.height;

	return {
		...nextBounds,
		x:
			fallbackWidth === NON_PASSTHROUGH_HUD_WIDTH_DIP
				? clamp(currentBounds.x, workArea.x, maxX)
				: nextBounds.x,
		y: clamp(currentBounds.y + currentBounds.height - nextBounds.height, workArea.y, maxY),
	};
}
