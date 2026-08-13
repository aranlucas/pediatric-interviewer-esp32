export const NOVA_3_QUERY_MODEL = "nova-3" as const;

export function requestedTranscriptionModel(uri: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).searchParams.get("model");
  } catch {
    return null;
  }
}
