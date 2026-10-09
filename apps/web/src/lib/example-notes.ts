/** A realistic, fictional note so a first-time tester can try the flow without inventing one. */
export function exampleNotes(displayName: string): string {
  const first = displayName.split(" ")[0] ?? "The learner";
  return [
    `${first} worked on fractions today. We started by checking last week's homework: ${first} got 4 out of 5 right and was pleased.`,
    `Adding fractions with different denominators was tricky at first. ${first} froze on 1/2 + 1/4, then drew a quick diagram and got it, and managed the next three unaided.`,
    `Confidence was noticeably better than last session; ${first} said "I think I get it now" and volunteered an answer before checking with me.`,
    `Focus was good for about 40 minutes, then drifted a little. Homework: five questions on equivalent fractions. Next time: subtracting fractions.`,
  ].join(" ");
}
