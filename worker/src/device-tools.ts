export const DEVICE_GPIO_PIN = 21 as const;
export const DEVICE_GPIO_HEADER_PIN = 6 as const;
export const DEVICE_GPIO_TOOL = "set_gpio" as const;

export type DeviceGpioState = "on" | "off";

export type ClientToolResultMessage = {
  type: "client_tool_result";
  id: string;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export function parseClientToolResult(message: string): ClientToolResultMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "client_tool_result" ||
    typeof candidate.id !== "string" ||
    candidate.id.length < 1 ||
    candidate.id.length > 80 ||
    typeof candidate.tool !== "string" ||
    candidate.tool.length < 1 ||
    candidate.tool.length > 40 ||
    typeof candidate.ok !== "boolean"
  ) {
    return null;
  }
  return {
    type: "client_tool_result",
    id: candidate.id,
    tool: candidate.tool,
    ok: candidate.ok,
    result: candidate.result,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  };
}
