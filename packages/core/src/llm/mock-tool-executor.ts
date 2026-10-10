import { acceptFinal, invokeTool, type ToolAgentExecutor, type ToolAgentRequest } from "./tool-loop";

export interface MockToolOptions {
  delayMs?: number;
  failAgents?: ReadonlySet<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Calls a tool through the real validation/scoping/event path and returns what the model would see. */
async function call(req: ToolAgentRequest, name: string, args: unknown): Promise<any> {
  const result = await invokeTool(req, name, args);
  return JSON.parse(result.content);
}

/**
 * Scripted stand-in for the Scheduler's model (MOCK_LLM and tests). It drives the REAL tools, so
 * argument validation, scoping and trace events behave exactly as with a live model; only the
 * "reasoning" (which calls to make, how to word the report) is fixed.
 */
async function scheduler(req: ToolAgentRequest) {
  const ctx = JSON.parse(/Check this request \(JSON\): (.*)$/s.exec(req.input)?.[1] ?? "{}") as {
    requestedNewStart: { startsAt: string; tutorLocalDate: string };
    currentClass: { startsAt: string };
  };
  const requested = new Date(ctx.requestedNewStart.startsAt);
  const around = requested.toISOString();
  const day = 3_600_000;
  const bookings = await call(req, "get_bookings", { from: new Date(requested.getTime() - 12 * day).toISOString(), to: new Date(requested.getTime() + 12 * day).toISOString() });
  const availability = await call(req, "get_tutor_availability", { date: ctx.requestedNewStart.tutorLocalDate });
  const exact = await call(req, "find_free_slots", { around, count: 1, searchHours: 1 });
  const near = await call(req, "find_free_slots", { around, count: 4, searchHours: 6 });

  const available = Array.isArray(exact.slots) && exact.slots[0]?.startsAt === around;
  const reasons: string[] = available ? ["Free, inside the tutor's working hours, with enough notice."] : [];
  if (!available) {
    if (availability.working === false || availability.error) reasons.push("The tutor does not work at that time.");
    else if (bookings.bookings?.some((b: { startsAt: string; endsAt: string }) => b.startsAt <= around && around < b.endsAt)) reasons.push("The tutor already has a class then.");
    else reasons.push("That time is not available (outside working hours or too soon).");
  }
  const alternatives = (near.slots ?? [])
    .filter((s: { startsAt: string }) => s.startsAt !== around)
    .slice(0, 2)
    .map((s: { startsAt: string; parentLocal: string }) => ({ startsAt: s.startsAt, reason: `Free, close to the requested time (${s.parentLocal}).` }));
  const final = { requestedSlot: { available, reasons }, alternatives, note: available ? "The requested slot works." : "The requested slot does not work; alternatives offered." };
  const accepted = acceptFinal(req, final);
  if (!accepted.ok) throw new Error(accepted.error);
  return { output: accepted.output, tokensIn: 600, tokensOut: 160, turns: 2, toolCalls: 4 };
}

const HANDLERS: Record<string, ToolAgentExecutor> = { scheduler_agent: scheduler };

export function createMockToolExecutor(options: MockToolOptions = {}): ToolAgentExecutor {
  const delay = options.delayMs ?? Number(process.env.MOCK_LLM_DELAY_MS ?? 0);
  return async (req) => {
    if (delay > 0) await sleep(delay);
    if (options.failAgents?.has(req.name)) throw new Error(`mock failure injected for ${req.name}`);
    const handler = HANDLERS[req.name];
    if (!handler) throw new Error(`mock tool executor has no handler for agent "${req.name}"`);
    return handler(req);
  };
}
