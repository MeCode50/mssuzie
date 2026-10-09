import type { KnownEntities } from "./types";

/** Build the redaction dictionary from DB records. Used locally only; never sent to a model. */
export function buildKnownEntities(src: {
  learner: { displayName: string; school: string | null; city: string | null };
  guardians: { name: string; email: string; phone: string }[];
  tutor: { name: string };
  extraSchools?: string[];
  extraCities?: string[];
}): KnownEntities {
  return {
    learnerName: src.learner.displayName,
    guardianNames: src.guardians.map((g) => g.name),
    guardianEmails: src.guardians.map((g) => g.email),
    guardianPhones: src.guardians.map((g) => g.phone),
    tutorName: src.tutor.name,
    schools: [...(src.learner.school ? [src.learner.school] : []), ...(src.extraSchools ?? [])],
    cities: [...(src.learner.city ? [src.learner.city] : []), ...(src.extraCities ?? [])],
  };
}
