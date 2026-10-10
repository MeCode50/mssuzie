export interface SeedSkill {
  skill: string;
  mastery: number;
  evidence: string;
}

export interface SeedSession {
  daysAgo: number;
  durationMin: number;
  notes: string;
  skills: SeedSkill[];
}

export interface SeedLearner {
  displayName: string;
  age: number;
  grade: string;
  subjects: string[];
  interests: string[];
  planHoursPerWeek: 2 | 3 | 4;
  tutor: "tutor1" | "tutor2";
  status: "on_track" | "watch" | "at_risk";
  school: string;
  city: string;
  guardian: { name: string; email: string; phone: string; timezone: string };
  events: { type: "exam" | "assignment"; subject: string; title: string; inDays: number }[];
  sessions: SeedSession[];
  parentUpdate?: { status: "draft" | "approved"; daysAgo: number; body: string };
  alert?: { severity: "medium" | "high"; reason: string; intervention: string; daysAgo: number };
}
