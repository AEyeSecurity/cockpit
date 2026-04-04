export async function isMainWindowFocused(): Promise<boolean> {
  try {
    const api = await import("@tauri-apps/api/window");
    return await api.getCurrentWindow().isFocused();
  } catch {
    if (typeof document !== "undefined" && typeof document.hasFocus === "function") {
      return document.hasFocus();
    }
    return true;
  }
}

