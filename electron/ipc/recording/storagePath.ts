import path from "node:path";

const RECORDED_VIDEO_FILE_NAME = /^recording-[0-9]+(?:-webcam)?\.(?:webm|mp4)$/;
const WEBCAM_VIDEO_FILE_NAME = /-webcam\.(?:webm|mp4)$/i;

/**
 * Whether a stored recording is the webcam companion rather than the screen
 * capture.
 *
 * Both are written through the same `store-recorded-video` channel and finish
 * in a race, so the finalizer has to tell them apart: cursor telemetry belongs
 * to the screen video, and attaching it to the webcam file leaves the editor
 * with no sidecar to load at all.
 */
export function isWebcamRecordingPath(videoPath: string): boolean {
	return WEBCAM_VIDEO_FILE_NAME.test(path.basename(videoPath));
}

export function resolveRecordedVideoStoragePath(recordingsDir: string, fileName: unknown): string {
	if (typeof fileName !== "string" || RECORDED_VIDEO_FILE_NAME.exec(fileName)?.[0] !== fileName) {
		throw new Error("Invalid recording file name");
	}

	const resolvedRecordingsDir = path.resolve(recordingsDir);
	const candidatePath = path.resolve(resolvedRecordingsDir, fileName);
	const relativePath = path.relative(resolvedRecordingsDir, candidatePath);

	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativePath)
	) {
		throw new Error("Invalid recording file name");
	}

	return candidatePath;
}
