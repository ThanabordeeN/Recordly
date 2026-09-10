import { BrowserWindow } from "electron";

export function emitRecordingInterrupted(reason: string, message: string) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-interrupted", { reason, message });
		}
	});
}

/**
 * A recording-related problem the user has to know about but which does not end
 * the recording: a degraded feature, or a fallback that changes what is
 * captured. Unlike emitRecordingInterrupted() the renderer only shows this.
 */
export function emitRecordingNotice(level: "warning" | "error", message: string) {
	BrowserWindow.getAllWindows().forEach((window) => {
		if (!window.isDestroyed()) {
			window.webContents.send("recording-notice", { level, message });
		}
	});
}
