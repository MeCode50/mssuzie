import type { SeedLearner } from "./types";

export const priya: SeedLearner = {
  displayName: "Priya Nair",
  age: 15,
  grade: "Year 11",
  subjects: ["Chemistry", "Maths"],
  interests: ["hockey", "podcasts", "medicine"],
  planHoursPerWeek: 4,
  tutor: "tutor1",
  status: "watch",
  school: "Kingsmead School",
  city: "Birmingham",
  guardian: { name: "Meera Nair", email: "meera.nair@example.com", phone: "+44 7700 900103", timezone: "Europe/London" },
  events: [
    { type: "exam", subject: "Chemistry", title: "GCSE Chemistry mock, paper 2", inDays: 18 },
    { type: "exam", subject: "Maths", title: "GCSE Maths mock, paper 1", inDays: 21 },
  ],
  sessions: [
    {
      daysAgo: 30, durationMin: 60,
      notes: "Priya wants to study medicine and is aiming for 8s and 9s. Chemistry: balancing equations is fine; moles calculations are shaky, she mixes up mass and Mr. Maths: quadratic factorising works when a = 1, falls apart otherwise. Very organised, brings annotated notes from Kingsmead School. Mentions she gets 'blank' under timed conditions. Homework: 10 moles questions.",
      skills: [
        { skill: "moles calculations", mastery: 0.45, evidence: "Confused mass and relative formula mass in 3 of 5 questions." },
        { skill: "balancing equations", mastery: 0.85, evidence: "Balanced all equations including polyatomic ions." },
        { skill: "factorising quadratics", mastery: 0.5, evidence: "Correct when a = 1; failed when a > 1." },
      ],
    },
    {
      daysAgo: 22, durationMin: 60,
      notes: "Moles improved with a formula triangle and units-first habit: 7/10 homework. Quadratics with a > 1 using the box method; she got two of five. She was frustrated and said she is 'behind everyone'. Percentage yield introduced. Priya is working hard, no concerns about effort, but the mocks are approaching and she is anxious. Mum Meera asked how to support revision at home.",
      skills: [
        { skill: "moles calculations", mastery: 0.6, evidence: "7/10 on homework using the units-first approach." },
        { skill: "factorising quadratics", mastery: 0.5, evidence: "2/5 when a > 1 using the box method." },
      ],
    },
    {
      daysAgo: 15, durationMin: 60,
      notes: "Timed Chemistry paper section: she ran out of time and left the 6-mark question blank, though she knew the content when we revisited. Time management is the main issue, not knowledge. Moles now fairly secure at 8/10. Quadratics still wobbly, 3/5. Agreed a one-minute-per-mark pacing rule. She seemed tense and rubbed her eyes a lot; says she is sleeping badly.",
      skills: [
        { skill: "moles calculations", mastery: 0.68, evidence: "8/10 on mixed moles questions." },
        { skill: "exam technique", mastery: 0.4, evidence: "Left a 6-mark question blank when time ran out." },
        { skill: "factorising quadratics", mastery: 0.55, evidence: "3/5 with a > 1." },
      ],
    },
    {
      daysAgo: 8, durationMin: 60,
      notes: "Better. Applied the pacing rule and finished the timed section with five minutes spare: 31/40. Concentration calculations are new and she picked them up quickly. Quadratics still the weakest topic at around 60% accuracy; we will do daily five-minute drills. Priya emailed me a worksheet from her teacher at Kingsmead and asked me to mark it at priya.nair.revision@example.com, which I will do. Mood better, still anxious about the mock.",
      skills: [
        { skill: "exam technique", mastery: 0.6, evidence: "Finished a timed section with time spare using one-minute-per-mark pacing." },
        { skill: "concentration calculations", mastery: 0.6, evidence: "Solved 4/5 after one worked example." },
        { skill: "factorising quadratics", mastery: 0.6, evidence: "About 60% accuracy on mixed drills." },
      ],
    },
    {
      daysAgo: 1, durationMin: 60,
      notes: "Mixed picture. Chemistry paper section 33/40, solid. Maths: quadratics drill 3/6, the same stubborn gap, and a sign slip pattern when a is negative. She is not progressing in maths as fast as chemistry and I worry about the Maths mock. She kept apologising for mistakes; perfectionism is hurting her. Plan: more maths time next fortnight and a short chat with Meera about rest before the mocks.",
      skills: [
        { skill: "factorising quadratics", mastery: 0.58, evidence: "3/6 on a drill; sign errors when a is negative." },
        { skill: "moles calculations", mastery: 0.75, evidence: "Consistently correct in the 33/40 chemistry section." },
        { skill: "exam technique", mastery: 0.65, evidence: "Paced the section well and showed full working." },
      ],
    },
  ],
};

export const tomas: SeedLearner = {
  displayName: "Tomás Silva",
  age: 7,
  grade: "Year 2",
  subjects: ["Reading", "Phonics"],
  interests: ["trains", "animals", "singing"],
  planHoursPerWeek: 2,
  tutor: "tutor2",
  status: "on_track",
  school: "Willowbrook Primary",
  city: "Cardiff",
  guardian: { name: "Inês Silva", email: "ines.silva@example.com", phone: "+44 7700 900104", timezone: "Europe/Lisbon" },
  events: [{ type: "exam", subject: "Phonics", title: "Phonics screening check", inDays: 30 }],
  sessions: [
    {
      daysAgo: 28, durationMin: 30,
      notes: "Tomás is bilingual (Portuguese at home) and very keen. Blending CVC words is good. Struggles with the 'ai', 'ee' and 'oa' vowel digraphs, reading 'rain' as 'ran'. Used a train-track game where each digraph is a station. He loved it and asked to play again. Inês says he reads to his baby sister at bedtime. Homework: five minutes of digraph flashcards.",
      skills: [
        { skill: "blending CVC words", mastery: 0.8, evidence: "Read 9/10 CVC words fluently." },
        { skill: "vowel digraphs", mastery: 0.35, evidence: "Misread 'rain' as 'ran' and 'feet' as 'fet'." },
      ],
    },
    {
      daysAgo: 21, durationMin: 30,
      notes: "Flashcards were done most days, and it shows. 'ai' and 'ee' now mostly right; 'oa' still confused with 'o'. Started on simple sentences with Willowbrook Primary's reading book. He read a whole page with only two prompts. Lots of smiles. Reading aloud with expression is a strength thanks to the singing.",
      skills: [
        { skill: "vowel digraphs", mastery: 0.55, evidence: "Correct on 'ai' and 'ee' words; 'oa' still confused." },
        { skill: "reading fluency", mastery: 0.5, evidence: "Read a full page with only two prompts." },
      ],
    },
    {
      daysAgo: 14, durationMin: 30,
      notes: "Excellent session. Digraphs 'ai', 'ee', 'oa' all secure on a 20-word list: 18/20. Introduced 'ou' and 'ow'. Nonsense words, as in the phonics check, were harder but he coped well with the 'alien words' idea. Reading comprehension: answered what and who questions. Tomás said 'I am a good reader now'.",
      skills: [
        { skill: "vowel digraphs", mastery: 0.8, evidence: "18/20 on a mixed digraph word list." },
        { skill: "nonsense words", mastery: 0.5, evidence: "Decoded alien words with some hesitation." },
      ],
    },
    {
      daysAgo: 6, durationMin: 30,
      notes: "Practised nonsense words ahead of the phonics screening check: 14/20, up from 10/20 last time. 'ou' and 'ow' sometimes swapped. Fluency good, now reading a full book page without prompts. Attention strong for 30 minutes. Inês is delighted and asked for book suggestions; I recommended some animal stories. No concerns.",
      skills: [
        { skill: "nonsense words", mastery: 0.7, evidence: "14/20 correct on nonsense words, up from 10/20." },
        { skill: "reading fluency", mastery: 0.75, evidence: "Read a full page unprompted." },
        { skill: "vowel digraphs", mastery: 0.85, evidence: "Secure on ai, ee, oa; ou/ow occasionally swapped." },
      ],
    },
  ],
  parentUpdate: {
    status: "draft", daysAgo: 6,
    body: "Hi Inês, Tomás had a lovely session this week. He is now reading a full page without help, and he got 14 out of 20 on the alien words we use to practise for the phonics check, which is up from 10. Next we will tidy up the 'ou' and 'ow' sounds. At home, a few minutes of animal stories before bed would be perfect. Warm regards, the MsSuzie team",
  },
};

export const zainab: SeedLearner = {
  displayName: "Zainab Bello",
  age: 11,
  grade: "Year 6",
  subjects: ["Maths", "English"],
  interests: ["robots", "poetry", "table tennis"],
  planHoursPerWeek: 3,
  tutor: "tutor2",
  status: "watch",
  school: "Riverside Primary",
  city: "Manchester",
  guardian: { name: "Hadiza Bello", email: "hadiza.bello@example.com", phone: "+44 7700 900105", timezone: "Europe/London" },
  events: [{ type: "exam", subject: "Maths", title: "KS2 SATs maths reasoning paper", inDays: 25 }],
  sessions: [
    {
      daysAgo: 32, durationMin: 60,
      notes: "Zainab is sharp and creative. Maths: arithmetic strong, but multi-step word problems trip her up because she skims the question. English: lovely poetry, but reading comprehension inference questions are patchy. Taught the 'underline the numbers, circle the question' routine. She is nervous about SATs at Riverside Primary and says her friends are 'all better than me'.",
      skills: [
        { skill: "multi-step word problems", mastery: 0.45, evidence: "Missed a required step in 4 of 6 word problems." },
        { skill: "inference", mastery: 0.5, evidence: "Answered 3/6 inference questions with evidence." },
        { skill: "mental arithmetic", mastery: 0.8, evidence: "Fluent on all timed arithmetic." },
      ],
    },
    {
      daysAgo: 25, durationMin: 60,
      notes: "Underline-and-circle routine helped: word problems 4/6. Fractions of amounts and percentages are a gap; she did not remember how to find 15% quickly. Taught 10% plus 5%. Poetry written about robots, beautiful use of imagery. Homework done, though late. She seems less nervous when we do it as a game.",
      skills: [
        { skill: "multi-step word problems", mastery: 0.58, evidence: "4/6 using the underline-and-circle routine." },
        { skill: "percentages", mastery: 0.4, evidence: "Could not find 15% without prompting." },
      ],
    },
    {
      daysAgo: 18, durationMin: 60,
      notes: "Percentages better: 10% then build up got her 5/6. Timed reasoning paper section: 12/20, she ran out of time on the last three questions. Perfectionism: rubs out working constantly. Inference questions improved when she finds a quote first: 4/6. Hadiza told me Zainab has been refusing to practise at home and cried over homework one evening.",
      skills: [
        { skill: "percentages", mastery: 0.62, evidence: "5/6 using 10%-then-build-up." },
        { skill: "exam technique", mastery: 0.4, evidence: "12/20 on timed section; last three questions unattempted." },
        { skill: "inference", mastery: 0.6, evidence: "4/6 once she locates a supporting quote first." },
      ],
    },
    {
      daysAgo: 11, durationMin: 60,
      notes: "Mixed. She got 14/20 on a timed paper but was tearful at the start after a bad day at school. Agreed she can skip a question and come back. Fractions of amounts secure. Ratio problems still confusing, around 50%. English inference is steady. Missed half the homework; Hadiza says evenings are chaotic. Tone of the session was gentle, we mostly did games.",
      skills: [
        { skill: "fractions of amounts", mastery: 0.75, evidence: "Correct on 5/6 fractions-of-amounts questions." },
        { skill: "ratio", mastery: 0.5, evidence: "About half right on ratio problems." },
        { skill: "exam technique", mastery: 0.5, evidence: "14/20 timed, using skip-and-return." },
      ],
    },
    {
      daysAgo: 4, durationMin: 60,
      notes: "Timed paper 15/20, her best so far. She used skip-and-return on her own and finished with a couple of minutes spare. Ratio improved with bar models: 4/6. A few careless slips in arithmetic when she rushed. Confidence a bit up, though she still says other children are better. SATs in about three and a half weeks. We should keep building timing and keep the sessions light.",
      skills: [
        { skill: "ratio", mastery: 0.62, evidence: "4/6 using bar models." },
        { skill: "exam technique", mastery: 0.65, evidence: "15/20 timed, finished with spare minutes." },
        { skill: "multi-step word problems", mastery: 0.68, evidence: "5/6 on word problems with all steps shown." },
      ],
    },
  ],
};
