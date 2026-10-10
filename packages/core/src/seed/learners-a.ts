import type { SeedLearner } from "./types";

export const amara: SeedLearner = {
  displayName: "Amara Okafor",
  age: 12,
  grade: "Year 8",
  subjects: ["Maths"],
  interests: ["football", "drawing", "baking"],
  planHoursPerWeek: 3,
  tutor: "tutor1",
  status: "on_track",
  school: "Oakfield Academy",
  city: "Leeds",
  guardian: { name: "Ngozi Okafor", email: "ngozi.okafor@example.com", phone: "+44 7700 900101", timezone: "Europe/London" },
  events: [{ type: "exam", subject: "Maths", title: "Year 8 algebra unit test", inDays: 12 }],
  sessions: [
    {
      daysAgo: 35, durationMin: 60,
      notes: "First proper session with Amara. Diagnostic on fractions: she can add fractions with the same denominator but freezes when the denominators differ. Said 'maths is just not my thing' twice. Used pizza slices and her football-pitch zones to make equivalent fractions visual. By the end she managed 1/2 + 1/4 with a drawing. Quiet but willing. Homework: five fraction-of-a-shape questions from the sheet.",
      skills: [
        { skill: "equivalent fractions", mastery: 0.3, evidence: "Could not find a common denominator without a drawing." },
        { skill: "adding fractions", mastery: 0.35, evidence: "Same denominators fine; different ones froze her." },
      ],
    },
    {
      daysAgo: 28, durationMin: 60,
      notes: "Amara did all of the homework and brought it unprompted, which is new. Fractions with different denominators now fine when she writes out the multiples. Slow but accurate. Started introducing letters for numbers (n + 3 = 7) using a missing-number game. She enjoyed it more than I expected and asked for 'harder ones'. Her mum, Ngozi, mentioned at pickup that Amara talked about the session at dinner.",
      skills: [
        { skill: "adding fractions", mastery: 0.55, evidence: "Solved 8/10 mixed-denominator questions unaided." },
        { skill: "algebraic expressions", mastery: 0.3, evidence: "Understood n as a missing number in simple one-step problems." },
      ],
    },
    {
      daysAgo: 21, durationMin: 60,
      notes: "Good session. Collecting like terms: she got 3a + 2a quickly but mixed up 3a + 2b at first, then self-corrected after I asked 'are apples and bananas the same?' Used her baking interest for ratios in a cake recipe. Confidence clearly up; she volunteered an answer before checking with me. Class teacher at Oakfield Academy has set an algebra unit test in a couple of weeks, so we will aim at that.",
      skills: [
        { skill: "collecting like terms", mastery: 0.55, evidence: "Self-corrected 3a + 2b after the apples-and-bananas prompt." },
        { skill: "algebraic expressions", mastery: 0.5, evidence: "Simplified six of eight expressions correctly." },
        { skill: "ratio", mastery: 0.5, evidence: "Scaled a recipe correctly for twice the guests." },
      ],
    },
    {
      daysAgo: 14, durationMin: 60,
      notes: "Solving two-step equations with a balance diagram. She is now drawing the balance herself without prompting. Made a sign error on 2x - 5 = 9 and found it when she substituted back to check, which is exactly the habit we want. Homework was done and neat. She said 'I actually kind of like this'. Brief chat with Ngozi about the test date.",
      skills: [
        { skill: "solving linear equations", mastery: 0.65, evidence: "Solved 7/9 two-step equations; caught her own sign error by substituting back." },
        { skill: "collecting like terms", mastery: 0.7, evidence: "Fluent on terms with positive coefficients." },
      ],
    },
    {
      daysAgo: 7, durationMin: 60,
      notes: "Equations with brackets and unknowns on both sides. Struggled for ten minutes on 3(x + 2) = 2x + 9 but kept going and cracked it, and she was proud. Practice paper section A: 14/18. Negative numbers still a weak spot when they appear inside brackets. Planning a short recap of negatives next time. Very positive energy today.",
      skills: [
        { skill: "solving linear equations", mastery: 0.75, evidence: "Solved a both-sides bracket equation after persisting through a long attempt." },
        { skill: "negative numbers", mastery: 0.55, evidence: "Slipped on signs when multiplying into brackets." },
      ],
    },
    {
      daysAgo: 2, durationMin: 60,
      notes: "Negatives recap went well; number line plus the 'owe and own' money idea worked. Then a timed mini-paper on algebra: 21/25, up from 14/18 last week. Amara explained her method to me out loud, which shows real understanding. She is asking to try Year 9 questions. Test in about ten days; I feel good about it.",
      skills: [
        { skill: "negative numbers", mastery: 0.75, evidence: "Used the owe-and-own model to handle signs inside brackets." },
        { skill: "solving linear equations", mastery: 0.82, evidence: "Scored 21/25 on a timed mini-paper and explained her method aloud." },
        { skill: "algebraic expressions", mastery: 0.8, evidence: "Expanded and simplified brackets accurately." },
      ],
    },
  ],
  parentUpdate: {
    status: "approved", daysAgo: 7,
    body: "Hi Ngozi, a quick update on Amara. This fortnight she has gone from avoiding fractions to solving equations with brackets, and last week she told us she actually likes maths. Next we are tidying up negative numbers and practising timed questions ahead of her algebra test. At home, ask her to explain one equation to you out loud, as teaching it back is a great way to lock it in. Warm regards, the MsSuzie team",
  },
};

export const leo: SeedLearner = {
  displayName: "Leo Hartmann",
  age: 9,
  grade: "Year 4",
  subjects: ["English", "Maths"],
  interests: ["dinosaurs", "Minecraft", "swimming"],
  planHoursPerWeek: 2,
  tutor: "tutor2",
  status: "at_risk",
  school: "St Brigid's Primary",
  city: "Bristol",
  guardian: { name: "Katrin Hartmann", email: "katrin.hartmann@example.com", phone: "+44 7700 900102", timezone: "America/Chicago" },
  events: [{ type: "assignment", subject: "English", title: "Reading journal, 3 entries", inDays: 6 }],
  sessions: [
    {
      daysAgo: 40, durationMin: 45,
      notes: "Leo bright and chatty. Reading comprehension on a short dinosaur text: decoded fluently but could not answer 'why' questions; gives one-word answers. Times tables: knows 2, 5, 10, shaky on 3 and 4. Sentence punctuation: forgets full stops in his own writing. Used Minecraft crafting as a hook for the 3 times table. Katrin says he is being moved down a reading group at St Brigid's Primary and is worried.",
      skills: [
        { skill: "reading comprehension", mastery: 0.4, evidence: "Answered literal questions, but could not explain why." },
        { skill: "times tables", mastery: 0.45, evidence: "Secure on 2, 5, 10; shaky on 3 and 4." },
        { skill: "sentence punctuation", mastery: 0.35, evidence: "Omitted full stops in a five-sentence paragraph." },
      ],
    },
    {
      daysAgo: 33, durationMin: 45,
      notes: "Slightly lower energy. Did not do the reading homework ('forgot'). Reading comprehension: a little better when we read together and I ask him to predict. Times tables: 3x recall around 6/10 in one minute. Wrote three sentences, two had full stops. He got distracted by the window a lot. Katrin mentioned they had a busy week with swimming lessons.",
      skills: [
        { skill: "reading comprehension", mastery: 0.42, evidence: "Predicted what would happen next with prompting." },
        { skill: "times tables", mastery: 0.48, evidence: "6/10 on 3x in one minute." },
      ],
    },
    {
      daysAgo: 26, durationMin: 45,
      notes: "Leo was fidgety and said 'this is boring' during the reading task. I swapped to a dinosaur fact-file and he re-engaged for ten minutes, then drifted again. Homework not done again. Comprehension answers still one word. Times tables 3x about the same as last week, no progress on 4x. I think he is tired; he yawned a lot. Spoke to Katrin about a short daily ten-minute reading routine.",
      skills: [
        { skill: "reading comprehension", mastery: 0.4, evidence: "Still giving one-word answers to 'why' questions." },
        { skill: "times tables", mastery: 0.46, evidence: "No gain on 3x; 4x not secure." },
      ],
    },
    {
      daysAgo: 19, durationMin: 30,
      notes: "Session cut to 30 minutes as Leo became upset when he got a sentence wrong and said 'I am rubbish at English, I hate it'. He would not read aloud. We did a calming drawing task and a short times-table game. No homework. Katrin said he has been reluctant to come to sessions and asked whether it is helping. I said we would adjust the approach, but honestly I am not seeing progress in his scores yet.",
      skills: [
        { skill: "reading comprehension", mastery: 0.36, evidence: "Refused to read aloud; could not complete the comprehension task." },
        { skill: "sentence punctuation", mastery: 0.33, evidence: "Full stops still missing in most sentences." },
      ],
    },
    {
      daysAgo: 12, durationMin: 45,
      notes: "Difficult session. Leo was unfocused and I had to re-ask questions several times. Reading comprehension score 3/10, down from 5/10 a month ago. Times tables 3x: 5/10. Homework not done for the fourth session running. He told me he does not want to do 'extra school'. Katrin emailed to say she is considering whether to continue, since his teacher reports no improvement at school and the reading group has not changed. I think a refund conversation is likely unless we turn this around soon.",
      skills: [
        { skill: "reading comprehension", mastery: 0.3, evidence: "Scored 3/10 on a comprehension check, down from 5/10." },
        { skill: "times tables", mastery: 0.42, evidence: "5/10 on 3x, lower than previous best." },
      ],
    },
  ],
  alert: {
    severity: "high", daysAgo: 12,
    reason: "Comprehension scores have fallen across four sessions, homework has been skipped four times in a row, Leo is saying he hates English, and his parent has said she is considering stopping because his teacher sees no improvement.",
    intervention: "Ops to call the family this week. Reset goals with smaller wins, move to interest-led reading (dinosaur and Minecraft texts), shorten tasks, and agree a short written progress check-in with the parent in two weeks.",
  },
};
