// Getting the file to the user (design.md 6): the system share sheet where
// there is one (iPhone / iPad: "Save to Files", GarageBand, Koala…), a plain
// download otherwise.

export type Delivery = "shared" | "downloaded" | "cancelled";

/** True when this browser can hand a WAV to the share sheet. */
export function canShareFiles(): boolean {
  if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
  try {
    const probe = new File([new Uint8Array(44)], "probe.wav", { type: "audio/wav" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** Opens the share sheet with the file. Must be called from a user gesture. */
export async function shareFile(blob: Blob, fileName: string, title?: string): Promise<Delivery> {
  const file = new File([blob], fileName, { type: blob.type || "audio/wav" });
  try {
    await navigator.share({ files: [file], title: title ?? fileName });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    throw error;
  }
}

/** Saves the file through the browser's download path. */
export function downloadFile(blob: Blob, fileName: string): Delivery {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}
