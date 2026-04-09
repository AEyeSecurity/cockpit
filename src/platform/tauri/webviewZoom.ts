export async function setWebviewZoom(scaleFactor: number): Promise<boolean> {
  try {
    const api = await import("@tauri-apps/api/webview");
    await api.getCurrentWebview().setZoom(scaleFactor);
    return true;
  } catch {
    return false;
  }
}
