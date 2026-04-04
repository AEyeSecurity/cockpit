export function isPackageConfigObject(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

export function normalizePackageConfig(input: unknown): Record<string, unknown> | null {
  if (!isPackageConfigObject(input)) {
    return null;
  }
  return { ...input };
}
