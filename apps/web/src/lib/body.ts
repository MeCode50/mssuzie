import type { ZodType } from "zod";
import { ApiError } from "./errors";

export const MAX_BODY_BYTES = 64 * 1024;

/** Read a JSON body with a size cap and content-type check, then validate it with zod. */
export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send the request as JSON (Content-Type: application/json).");
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw tooLarge();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "validation_failed", "The request body isn't valid JSON.");
  }
  return schema.parse(raw);
}

const tooLarge = () => new ApiError(413, "payload_too_large", "That request is too large.");
