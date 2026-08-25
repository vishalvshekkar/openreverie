// Fixture corpus and query set for the retrieval evaluation harness
// (retrievalEval.test.ts).
//
// Entirely synthetic. No content here comes from any developer's own
// .reverie memory folder; AGENTS.md forbids that from ever entering the
// repo. The concert cluster below is modeled on the shape of the observed
// failure recorded in
// docs/superpowers/plans/2026-08-24-recall-and-event-time-fixes.md (a plan
// mentioned vaguely on an early date, revised with a precise day and time
// on a later date, and a similar-sounding but different event nearby in
// time), with invented names, places and dates standing in for the real
// ones.
//
// Document shapes match what the real indexer sees: session summaries
// carry `items` in frontmatter (buildChunks emits one chunk per item, which
// is the shape that triggers the FTS defect), daily rollups and living
// documents (arc, person, constitution) carry prose in the body only. The
// four "precise" cluster documents also carry a few filler items alongside
// the one with the exact date, the same shape as the real failure: the
// correct fact was one line among several in the same document, not the
// only thing in it.
//
// Every distractor deliberately shares most of its vocabulary with the
// document it is a near-miss for (same subject, same names, same place),
// differing mainly in date and in whether the thing actually happened or
// got booked. That is the point: a distractor built from unrelated words
// is not a near miss, it is just a different document, and cosine
// similarity over shared content words would separate the two trivially,
// which would make recall@k look better than the real corpus (465 chunks,
// full of exactly this kind of overlap) ever does.

import type { Document } from './documents.js'
import type { EvalQuery } from './retrievalEval.js'
import type { DocKind } from './sqlite.js'

export const EVAL_MODEL = 'eval-fixture-model'

export interface EvalFixtureDoc {
  doc: Document
  kind: DocKind
}

interface FixtureItem {
  id: string
  text: string
  kind: 'observation' | 'feeling' | 'event' | 'intention'
  ts: string
  eventTime?: string
}

function summaryDoc(id: string, date: string, items: FixtureItem[], body = ''): EvalFixtureDoc {
  return {
    doc: {
      path: `/eval/sessions/${date}-session_${id}/summary.md`,
      meta: { id, date, items },
      body,
    },
    kind: 'summary',
  }
}

function rollupDoc(id: string, date: string, body: string): EvalFixtureDoc {
  return {
    doc: {
      path: `/eval/rollups/daily/${date}.md`,
      meta: { id, date },
      body,
    },
    kind: 'rollup_daily',
  }
}

function livingDoc(
  id: string,
  path: string,
  kind: 'arc' | 'person' | 'constitution',
  body: string,
  extraMeta: Record<string, unknown> = {},
): EvalFixtureDoc {
  return {
    doc: {
      path,
      meta: { id, ...extraMeta },
      body,
    },
    kind,
  }
}

export function evalFixtureDocuments(): EvalFixtureDoc[] {
  return [
    // --- Cluster: concert plan with Priya. Modeled on the observed
    // failure: vague mention, then a precise booking with a day and time
    // (plus filler items about the same event, same as the real summary
    // that buried the precise fact among unrelated lines), then a
    // similar-sounding but different event nearby in time that shares the
    // same venue and half the same people.
    summaryDoc('doc_concert_vague', '2026-08-10', [
      {
        id: 'item_concert_vague_1',
        text: 'Mentioned a possible Solstice concert with Priya at Cascade Hall, probably next weekend, nothing confirmed yet.',
        kind: 'intention',
        ts: '2026-08-10',
        eventTime: 'probably next weekend',
      },
    ]),
    summaryDoc('doc_concert_booked', '2026-08-18', [
      {
        id: 'item_concert_booked_1',
        text: 'Tickets confirmed: the Solstice concert with Priya at Cascade Hall, Saturday 22 Aug 2026 at 7:30pm.',
        kind: 'event',
        ts: '2026-08-18',
      },
      {
        id: 'item_concert_booked_2',
        text: 'Priya is excited about the Solstice concert at Cascade Hall, been talking about it all week.',
        kind: 'feeling',
        ts: '2026-08-18',
      },
      {
        id: 'item_concert_booked_3',
        text: 'Still need to figure out what to wear to the Solstice concert with Priya.',
        kind: 'observation',
        ts: '2026-08-18',
      },
      {
        id: 'item_concert_booked_4',
        text: 'Bought new shoes ahead of the Solstice concert at Cascade Hall.',
        kind: 'event',
        ts: '2026-08-18',
      },
    ]),
    summaryDoc('doc_concert_distractor', '2026-08-14', [
      {
        id: 'item_concert_distractor_1',
        text: "Went to a different act, also at Cascade Hall, called Solstice Sessions rather than the main Solstice concert, with Priya's friend Meera, on Friday 14 Aug 2026 at 9pm.",
        kind: 'event',
        ts: '2026-08-14',
      },
    ]),

    // --- Cluster: work deadline. Precise and distractor are the same
    // deadline at two different dates: the client's earlier floated date,
    // and the one it actually got confirmed to.
    summaryDoc('doc_deadline_precise', '2026-08-12', [
      {
        id: 'item_deadline_precise_1',
        text: 'Meridian project deadline confirmed for Thursday 20 Aug 2026, deliverables due to the client by 5pm.',
        kind: 'event',
        ts: '2026-08-12',
      },
      {
        id: 'item_deadline_precise_2',
        text: 'Feeling the pressure of the Meridian project deadline creeping closer.',
        kind: 'feeling',
        ts: '2026-08-12',
      },
      {
        id: 'item_deadline_precise_3',
        text: 'Spent the afternoon prepping slides for the Meridian project deadline.',
        kind: 'event',
        ts: '2026-08-12',
      },
      {
        id: 'item_deadline_precise_4',
        text: 'The Meridian project deadline keeps coming up in every standup this week.',
        kind: 'observation',
        ts: '2026-08-12',
      },
    ]),
    summaryDoc('doc_deadline_distractor', '2026-08-13', [
      {
        id: 'item_deadline_distractor_1',
        text: 'An earlier date for the Meridian project deadline, Friday 21 Aug 2026 at noon, was floated by the client and later moved up to Thursday.',
        kind: 'event',
        ts: '2026-08-13',
      },
    ]),

    // --- Cluster: hiking trip. Precise and distractor are the same trip
    // at two different departure dates: an earlier plan that fell through
    // before booking, and the flight that actually got booked.
    summaryDoc('doc_trip_precise', '2026-08-15', [
      {
        id: 'item_trip_precise_1',
        text: 'Flights booked to Ooty for the Nilgiris hiking trip, departing Wednesday 26 Aug 2026 at 6am.',
        kind: 'event',
        ts: '2026-08-15',
      },
      {
        id: 'item_trip_precise_2',
        text: 'Excited about the Nilgiris hiking trip to Ooty, been researching trails all week.',
        kind: 'feeling',
        ts: '2026-08-15',
      },
      {
        id: 'item_trip_precise_3',
        text: 'Bought new hiking boots ahead of the Nilgiris trip to Ooty.',
        kind: 'event',
        ts: '2026-08-15',
      },
      {
        id: 'item_trip_precise_4',
        text: 'Packed a first-aid kit for the Nilgiris hiking trip.',
        kind: 'event',
        ts: '2026-08-15',
      },
    ]),
    summaryDoc('doc_trip_distractor', '2026-08-02', [
      {
        id: 'item_trip_distractor_1',
        text: 'An earlier plan for the Nilgiris hiking trip had flights to Ooty departing Sunday 2 Aug 2026, but that plan was cancelled before anything was booked.',
        kind: 'event',
        ts: '2026-08-02',
      },
    ]),

    // --- Cluster: birthday dinner. Precise and distractor are the same
    // dinner idea at two different dates: an earlier idea that got
    // dropped, and the one that actually got confirmed.
    summaryDoc('doc_bday_vague', '2026-08-01', [
      {
        id: 'item_bday_vague_1',
        text: "Mentioned wanting to plan something for Meera's birthday next month.",
        kind: 'intention',
        ts: '2026-08-01',
        eventTime: 'next month',
      },
    ]),
    summaryDoc('doc_bday_precise', '2026-08-19', [
      {
        id: 'item_bday_precise_1',
        text: 'Birthday dinner for Meera confirmed at Amara restaurant on Saturday 29 Aug 2026 at 8pm.',
        kind: 'event',
        ts: '2026-08-19',
      },
    ]),
    summaryDoc('doc_bday_distractor', '2026-08-09', [
      {
        id: 'item_bday_distractor_1',
        text: "An earlier idea for Meera's birthday dinner at Amara restaurant, maybe Sunday 9 Aug 2026, got dropped before anything was booked.",
        kind: 'event',
        ts: '2026-08-09',
      },
    ]),

    // --- Cluster: book club. Precise and distractor are the same club's
    // first meeting at two different dates: an earlier date that got
    // cancelled and rescheduled, and the one it actually happened on.
    summaryDoc('doc_book_vague', '2026-07-20', [
      {
        id: 'item_book_vague_1',
        text: 'Considering joining a book club that meets sometime in August, still deciding.',
        kind: 'intention',
        ts: '2026-07-20',
        eventTime: 'sometime in August',
      },
    ]),
    summaryDoc('doc_book_precise', '2026-08-11', [
      {
        id: 'item_book_precise_1',
        text: 'Joined the Riverside book club, first meeting Tuesday 25 Aug 2026 at 7pm at the community library.',
        kind: 'event',
        ts: '2026-08-11',
      },
      {
        id: 'item_book_precise_2',
        text: 'Nervous but looking forward to the first Riverside book club meeting.',
        kind: 'feeling',
        ts: '2026-08-11',
      },
      {
        id: 'item_book_precise_3',
        text: 'Started reading the book picked for the Riverside book club.',
        kind: 'event',
        ts: '2026-08-11',
      },
      {
        id: 'item_book_precise_4',
        text: 'Meera mentioned she might also join the Riverside book club.',
        kind: 'observation',
        ts: '2026-08-11',
      },
    ]),
    summaryDoc('doc_book_distractor', '2026-08-04', [
      {
        id: 'item_book_distractor_1',
        text: 'An earlier Riverside book club meeting was planned for Tuesday 4 Aug 2026 at 6pm at the community library, but it got cancelled and rescheduled to the 25th.',
        kind: 'event',
        ts: '2026-08-04',
      },
    ]),

    // --- Noise: unrelated daily content, padding the corpus so the
    // candidate window has more than the cluster documents to sort
    // through, and so the vector lane's diagnostic count reflects a real
    // window rather than the entire tiny corpus.
    summaryDoc('doc_noise_gym', '2026-08-06', [
      {
        id: 'item_noise_gym_1',
        text: 'Went to the gym in the morning, did a light strength session.',
        kind: 'event',
        ts: '2026-08-06',
      },
      {
        id: 'item_noise_gym_2',
        text: 'Felt tired for most of the afternoon.',
        kind: 'feeling',
        ts: '2026-08-06',
      },
    ]),
    summaryDoc('doc_noise_work', '2026-08-07', [
      {
        id: 'item_noise_work_1',
        text: 'Long meeting about the quarterly roadmap, nothing decided.',
        kind: 'observation',
        ts: '2026-08-07',
      },
      {
        id: 'item_noise_work_2',
        text: 'Ate lunch alone at the desk again.',
        kind: 'observation',
        ts: '2026-08-07',
      },
    ]),
    summaryDoc('doc_noise_weather', '2026-08-16', [
      {
        id: 'item_noise_weather_1',
        text: 'Rained most of the day, stayed in and read.',
        kind: 'observation',
        ts: '2026-08-16',
      },
      {
        id: 'item_noise_weather_2',
        text: 'Called a cousin in the evening just to catch up.',
        kind: 'event',
        ts: '2026-08-16',
      },
    ]),
    summaryDoc('doc_noise_traffic', '2026-08-03', [
      {
        id: 'item_noise_traffic_1',
        text: 'Bad traffic on the way back from work, took an hour longer than usual.',
        kind: 'observation',
        ts: '2026-08-03',
      },
      {
        id: 'item_noise_traffic_2',
        text: 'Skipped the evening walk, too tired after the commute.',
        kind: 'event',
        ts: '2026-08-03',
      },
    ]),
    summaryDoc('doc_noise_cooking', '2026-08-17', [
      {
        id: 'item_noise_cooking_1',
        text: 'Tried a new recipe for dinner, turned out better than expected.',
        kind: 'event',
        ts: '2026-08-17',
      },
      {
        id: 'item_noise_cooking_2',
        text: 'Felt pretty pleased with how the evening went.',
        kind: 'feeling',
        ts: '2026-08-17',
      },
    ]),
    summaryDoc('doc_noise_laundry', '2026-08-08', [
      {
        id: 'item_noise_laundry_1',
        text: 'Finally caught up on laundry that had been piling up all week.',
        kind: 'event',
        ts: '2026-08-08',
      },
      {
        id: 'item_noise_laundry_2',
        text: 'Reorganized the closet while at it.',
        kind: 'observation',
        ts: '2026-08-08',
      },
    ]),
    summaryDoc('doc_noise_podcast', '2026-08-20', [
      {
        id: 'item_noise_podcast_1',
        text: 'Listened to a new podcast episode on the commute, mostly forgettable.',
        kind: 'observation',
        ts: '2026-08-20',
      },
      {
        id: 'item_noise_podcast_2',
        text: 'Considering unsubscribing from a couple of newsletters.',
        kind: 'intention',
        ts: '2026-08-20',
      },
    ]),
    summaryDoc('doc_noise_neighbor', '2026-08-09', [
      {
        id: 'item_noise_neighbor_1',
        text: 'Ran into a neighbor in the hallway, chatted for a few minutes.',
        kind: 'event',
        ts: '2026-08-09',
      },
      {
        id: 'item_noise_neighbor_2',
        text: 'Meant to water the plants and forgot again.',
        kind: 'observation',
        ts: '2026-08-09',
      },
    ]),
    summaryDoc('doc_noise_email', '2026-08-06', [
      {
        id: 'item_noise_email_1',
        text: 'Cleared out a backlog of unread email, most of it not urgent.',
        kind: 'event',
        ts: '2026-08-06',
      },
      {
        id: 'item_noise_email_2',
        text: 'Felt a little more on top of things afterward.',
        kind: 'feeling',
        ts: '2026-08-06',
      },
    ]),

    // --- Daily rollups. Two carry the same clusters' vague mentions in
    // prose, before either got a specific date; the rest are unrelated
    // filler days.
    rollupDoc(
      'doc_rollup_0805',
      '2026-08-05',
      'General day, caught up on emails, nothing eventful. There was a vague sense that the Meridian project deadline is due sometime next week, though nothing was confirmed yet.',
    ),
    rollupDoc(
      'doc_rollup_0728',
      '2026-07-28',
      'General day. Talked about maybe going hiking in the Nilgiris sometime this fall, no dates set yet.',
    ),
    rollupDoc(
      'doc_rollup_0801',
      '2026-08-01',
      'Quiet day, mostly errands and a short walk in the evening. Nothing else notable.',
    ),
    rollupDoc(
      'doc_rollup_0810',
      '2026-08-10',
      'Slow start to the day, caught up on reading, nothing notable happened.',
    ),
    rollupDoc(
      'doc_rollup_0803',
      '2026-08-03',
      'Ordinary day, worked through a long to-do list, nothing worth dwelling on.',
    ),
    rollupDoc(
      'doc_rollup_0821',
      '2026-08-21',
      'Low-key day at home, mostly cleaning and catching up on chores.',
    ),

    // --- Living documents: arcs, people, constitution.
    livingDoc(
      'doc_arc_social',
      '/eval/arcs/social.md',
      'arc',
      'The friends and social plans arc tracks get-togethers, dinners and shows with the people in this life: mostly Priya and Meera lately, plus whoever else comes up in a given month. It holds the thread across individual sessions, not any one date.',
      { opened: '2026-06-01', updated: '2026-08-18' },
    ),
    livingDoc(
      'doc_arc_wellness',
      '/eval/arcs/wellness.md',
      'arc',
      'The health and movement arc tracks the gym routine, hiking trips and general activity level over time. It is a running thread, not a single event.',
      { opened: '2026-05-10', updated: '2026-08-15' },
    ),
    livingDoc(
      'doc_arc_work',
      '/eval/arcs/work.md',
      'arc',
      'The work arc tracks projects, deadlines and how the job is generally going, across whichever project happens to be current. It is a running thread, not tied to any one deadline.',
      { opened: '2026-04-01', updated: '2026-08-12' },
    ),
    livingDoc(
      'doc_person_priya',
      '/eval/people/priya.md',
      'person',
      'Priya is a close friend, met a few years ago. Enjoys live music and concerts, usually the one suggesting a show. Works in a different field, so plans tend to happen on weekends.',
    ),
    livingDoc(
      'doc_person_meera',
      '/eval/people/meera.md',
      'person',
      'Meera is a coworker turned friend. Into books and tribute nights, part of the same friend group as Priya. Recently joined a book club.',
    ),
    livingDoc(
      'doc_person_arjun',
      '/eval/people/arjun.md',
      'person',
      'Arjun is a former coworker, stayed in touch. Not part of the usual Priya-and-Meera plans, comes up mostly around work-adjacent catch-ups.',
    ),
    livingDoc(
      'doc_constitution',
      '/eval/constitution.md',
      'constitution',
      "Prefers being reminded of upcoming plans with the exact date and time when one is known, not a vague reference like 'soon' or 'this week'. If only a vague mention exists, say so plainly rather than guessing at a date.",
    ),
  ]
}

// Natural-language queries are written the way the chat model actually
// writes them per the search_memory tool description: full sentences of
// roughly 10 to 15 tokens. A handful of short keyword queries close the set
// out for contrast, since that is the query shape every existing unit test
// used, and the shape that always found something.
export const EVAL_QUERIES: EvalQuery[] = [
  {
    id: 'q01',
    query: 'What day and time is the Solstice concert with Priya actually booked for?',
    expectedDocId: 'doc_concert_booked',
    shape: 'natural',
  },
  {
    id: 'q02',
    query:
      'Did that separate Solstice Sessions night with Meera at Cascade Hall already happen this month?',
    expectedDocId: 'doc_concert_distractor',
    shape: 'natural',
  },
  {
    id: 'q03',
    query:
      'When exactly is the Meridian project deadline the client is expecting deliverables for?',
    expectedDocId: 'doc_deadline_precise',
    shape: 'natural',
  },
  {
    id: 'q04',
    query: 'What was the earlier date floated for the Meridian deadline before it got moved?',
    expectedDocId: 'doc_deadline_distractor',
    shape: 'natural',
  },
  {
    id: 'q05',
    query: 'What time does the flight to Ooty for the Nilgiris hiking trip leave?',
    expectedDocId: 'doc_trip_precise',
    shape: 'natural',
  },
  {
    id: 'q06',
    query:
      'What was the earlier cancelled plan for the Nilgiris trip flights before it got rebooked?',
    expectedDocId: 'doc_trip_distractor',
    shape: 'natural',
  },
  {
    id: 'q07',
    query: "What time and place is Meera's birthday dinner actually happening?",
    expectedDocId: 'doc_bday_precise',
    shape: 'natural',
  },
  {
    id: 'q08',
    query: "What was the earlier dropped idea for Meera's birthday dinner at Amara restaurant?",
    expectedDocId: 'doc_bday_distractor',
    shape: 'natural',
  },
  {
    id: 'q09',
    query: 'What day and time is the first Riverside book club meeting happening?',
    expectedDocId: 'doc_book_precise',
    shape: 'natural',
  },
  {
    id: 'q10',
    query: 'What was the earlier cancelled date for the Riverside book club meeting?',
    expectedDocId: 'doc_book_distractor',
    shape: 'natural',
  },
  {
    id: 'q11',
    query: 'Is there anything booked yet for a show or concert with Priya this month?',
    expectedDocId: 'doc_concert_vague',
    shape: 'natural',
  },
  {
    id: 'q12',
    query: "Has anything been decided yet about what to do for Meera's birthday?",
    expectedDocId: 'doc_bday_vague',
    shape: 'natural',
  },
  {
    id: 'q13',
    query: 'Is joining that book club in August still just an idea or is it confirmed?',
    expectedDocId: 'doc_book_vague',
    shape: 'natural',
  },
  {
    id: 'q14',
    query:
      'Was there an earlier vague mention of a possible Nilgiris hiking trip before it got booked?',
    expectedDocId: 'doc_rollup_0728',
    shape: 'natural',
  },
  {
    id: 'q15',
    query: 'Was the Meridian deadline mentioned informally before it got officially confirmed?',
    expectedDocId: 'doc_rollup_0805',
    shape: 'natural',
  },
  {
    id: 'q16',
    query: 'What does the constitution say about how plans and dates should be communicated?',
    expectedDocId: 'doc_constitution',
    shape: 'natural',
  },
  {
    id: 'q17',
    query: 'What kind of things does the friends and social plans arc usually track?',
    expectedDocId: 'doc_arc_social',
    shape: 'natural',
  },
  {
    id: 'q18',
    query: "What does Priya's person page say about her interests and hobbies?",
    expectedDocId: 'doc_person_priya',
    shape: 'natural',
  },
  {
    id: 'q19',
    query: 'What happened on the quiet day mostly spent running errands and walking?',
    expectedDocId: 'doc_rollup_0801',
    shape: 'natural',
  },
  // Short keyword queries, for contrast against the natural-language ones
  // above. These already clear the FTS lane's implicit-AND bar today, which
  // is exactly why no existing unit test caught defect 5: every one of them
  // queries this way.
  {
    id: 'q20',
    query: 'Solstice concert Priya',
    expectedDocId: 'doc_concert_booked',
    shape: 'keyword',
  },
  {
    id: 'q21',
    query: 'Meridian deadline',
    expectedDocId: 'doc_deadline_precise',
    shape: 'keyword',
  },
  {
    id: 'q22',
    query: 'Ooty Nilgiris flights',
    expectedDocId: 'doc_trip_precise',
    shape: 'keyword',
  },
  {
    id: 'q23',
    query: 'book club Riverside',
    expectedDocId: 'doc_book_precise',
    shape: 'keyword',
  },
  // q24 is deliberately NOT rewritten to match: 'flight' (singular) never
  // appears in doc_trip_precise, only 'Flights' (plural, and in a
  // different case), so this 3-token keyword query also returns zero FTS
  // hits today. It shows the implicit-AND bug (defect 5) is not purely a
  // long-query problem: word-form mismatch alone starves even a short
  // query. Kept separate from q22's rewritten, currently-passing version
  // rather than replacing it, so both the "keyword queries already work"
  // floor and this genuine finding stay visible. See retrievalEval.test.ts
  // for where this is asserted (skipped, alongside the A2 assertions).
  {
    id: 'q24',
    query: 'Nilgiris flight Ooty',
    expectedDocId: 'doc_trip_precise',
    shape: 'keyword',
  },
]
