export const meta = {
  name: 'feature',
  description: 'Spec, build, review, inspect and write up a CardDesk / Tyche Cards feature with the agent team',
  whenToUse: 'A new feature or a substantial improvement. Pass args: { feature: "what to build", context: "decisions already made" }. Deploying stays with the main session.',
  phases: [
    { title: 'Spec', detail: 'product-lead writes the spec and acceptance criteria' },
    { title: 'Build', detail: 'builder implements with tests' },
    { title: 'Review', detail: 'critic and inspector check the change in parallel' },
    { title: 'Fix', detail: 'builder fixes blocking findings (up to 2 rounds)' },
    { title: 'Market', detail: 'marketer drafts release notes, emails and copy' },
  ],
}

// Each agent takes its role from .claude/agents/<role>.md. CLAUDE.md is loaded for every agent.
const role = (name) => `Act as the "${name}" agent: read .claude/agents/${name}.md first and follow it exactly.`
const feature = (args && args.feature) || ''
const context = (args && args.context) || 'None given.'
if (!feature) throw new Error('Pass args.feature: what to build.')

const REVIEW = {
  type: 'object',
  properties: {
    ship: { type: 'boolean', description: 'true if this can ship as is' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'should_fix', 'nit'] },
          title: { type: 'string' },
          detail: { type: 'string', description: 'what goes wrong, failure scenario, smallest fix' },
          where: { type: 'string', description: 'file:line, screen, or command' },
        },
        required: ['severity', 'title', 'detail'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['ship', 'findings', 'summary'],
}

phase('Spec')
const spec = await agent(`${role('product-lead')}

Feature request: ${feature}

Decisions already made by the owner: ${context}

Write the spec to docs/specs/<short-slug>.md and also return its full text.`, { label: 'product-lead: spec', phase: 'Spec' })

phase('Build')
let build = await agent(`${role('builder')}

Implement this spec on the current branch. Commit your work when tests pass (one or more commits).

${spec}`, { label: 'builder: implement', phase: 'Build' })

const reviewers = [
  ['critic', 'Review the change set on this branch against main (git diff main...HEAD).'],
  ['inspector', 'Inspect the change set on this branch: tests, builds, e2e, the acceptance criteria and ease of use.'],
]
const review = (round) => parallel(reviewers.map(([name, ask]) => () =>
  agent(`${role(name)}

${ask}

Spec (for acceptance criteria):
${spec}

Builder's report:
${build}`, { label: `${name}: round ${round}`, phase: round === 1 ? 'Review' : 'Fix', schema: REVIEW })))

let reviews = (await review(1)).filter(Boolean)
let round = 1
const blocking = (rs) => rs.flatMap((r) => r.findings || []).filter((f) => f.severity === 'blocking' || (f.severity === 'should_fix' && !rs.every((x) => x.ship)))

while (blocking(reviews).length && round < 3) {
  phase('Fix')
  const todo = blocking(reviews)
  log(`Round ${round}: ${todo.length} finding(s) to fix`)
  build = await agent(`${role('builder')}

Fix these findings from the critic and inspector, then re-run the tests and builds and commit.
Explain any finding you believe is wrong instead of changing code for it.

${todo.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} (${f.where || 'n/a'}): ${f.detail}`).join('\n')}

Spec:
${spec}`, { label: `builder: fix round ${round}`, phase: 'Fix' })
  round += 1
  reviews = (await review(round)).filter(Boolean)
}
const left = blocking(reviews)
if (left.length) log(`${left.length} finding(s) still open after ${round - 1} fix round(s); see the result.`)

phase('Market')
const marketing = await agent(`${role('marketer')}

The feature below has been built on this branch (not yet shipped). Draft the release materials.
Read the code for what it actually does.

Spec:
${spec}

Builder's final report:
${build}`, { label: 'marketer: release drafts', phase: 'Market' })

return {
  spec,
  build,
  reviews: reviews.map((r) => ({ ship: r.ship, summary: r.summary, findings: r.findings })),
  openFindings: left,
  marketing,
  readyToShip: reviews.length === 2 && reviews.every((r) => r.ship) && !left.length,
}
