/**
 * A cheap, deterministic screen for messages that try to instruct the system rather than ask for a
 * class to move. A hit never changes what the agents may do on its own: it only stops automatic action
 * and sends the request to a person. (The agents also treat the message as untrusted data.)
 */
const PATTERNS: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass)\b.{0,40}\b(previous|prior|above|earlier|all|any|your|the|these)\b.{0,40}\b(instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?|constraints?)\b/i, "tells the system to ignore its instructions"],
  [/\b(system|developer)\s*(prompt|message|instructions?)\b/i, "refers to the system prompt"],
  [/\byou\s+are\s+(now|no\s+longer)\b|\bact\s+as\b.{0,30}\b(admin|administrator|ops|root|developer)\b|\bpretend\s+(to\s+be|you)\b/i, "tries to change the assistant's role"],
  [/\b(reveal|show|print|leak|repeat|output|tell\s+me)\b.{0,40}\b(prompt|instructions?|api\s*key|secret|password|token|credentials?)\b/i, "asks for hidden information"],
  [/<\s*\/?\s*(system|assistant|tool|instructions?)\s*>|\[\s*(system|inst)\s*\]/i, "contains fake system markup"],
  [/\b(without\s+(checking|asking|approval|policy)|skip\s+(the\s+)?(checks?|policy|approval)|auto[- ]?approve|approve\s+(it\s+)?(anyway|regardless))\b/i, "asks to skip the checks"],
  [/\b(forward|send|email|cc|bcc)\b.{0,60}[\w.+-]+@[\w-]+\.[\w.-]+/i, "asks for mail to be sent to an address"],
  [/\b(all|every|each)\s+(of\s+)?(the\s+)?(bookings?|classes|lessons?|students?|learners?|children|tutors?)\b/i, "asks to change everyone's schedule"],
];

export interface InjectionScan {
  suspicious: boolean;
  reasons: string[];
}

export function scanForInjection(message: string): InjectionScan {
  const reasons = PATTERNS.filter(([re]) => re.test(message)).map(([, why]) => why);
  return { suspicious: reasons.length > 0, reasons };
}
