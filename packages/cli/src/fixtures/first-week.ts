// Synthetic fixture data for the end-to-end harness (../e2e.test.ts).
//
// Three invented days in a made-up person's life, plus one present-day
// conversation: buying a secondhand table saw and starting a first
// woodworking project, and quietly starting a job search. The friend named
// here, Priya Chen, is invented too. None of this is real personal data.

import type { ReflectionOutput } from '@openreverie/memory'

export interface FixtureTurn {
  user: string
  assistant: string
}

export const DAY_ONE_DATE = '2026-08-11'
export const DAY_TWO_DATE = '2026-08-12'
export const DAY_THREE_DATE = '2026-08-13'
export const MAINTENANCE_NOW = new Date('2026-08-14T09:00:00Z')

export const WOODWORKING_ARC_NAME = 'Woodworking'
export const WOODWORKING_REALM_NAME = 'Craft and hobbies'
export const JOB_SEARCH_ARC_NAME = 'Job search'
export const JOB_SEARCH_REALM_NAME = 'Career'

// Distinctive enough that a search for it can only plausibly match the day
// one summary, proving retrieval reaches back to a specific past detail.
export const DISTINCTIVE_DAY_ONE_PHRASE = 'secondhand table saw'

export interface ArcIds {
  woodworking: string
  jobSearch: string
}

export const dayOneTurns: FixtureTurn[] = [
  {
    user: "I bought a secondhand table saw this weekend and I'm starting a bookshelf, my first real woodworking project.",
    assistant: "That's a solid first project. How are you feeling about it?",
  },
  {
    user: "Also, quietly, I've started looking for a new job. I feel stuck where I am, and I mentioned it to my friend Priya Chen, who said she'd keep an ear out.",
    assistant:
      'Good that you have someone in your corner for that. One step at a time on both fronts.',
  },
]

export const dayOneRememberText = 'Wants to build a bookshelf as the first woodworking project'

export function dayOneReflection(): ReflectionOutput {
  return {
    summary:
      'Bought a secondhand table saw this weekend and started a first bookshelf project, and quietly began a job search.',
    items: [
      { text: 'Bought a secondhand table saw and started building a bookshelf', kind: 'event' },
      { text: 'Started quietly looking for a new job after feeling stuck', kind: 'event' },
    ],
    attributions: [],
    newArcs: [
      {
        name: WOODWORKING_ARC_NAME,
        realm: WOODWORKING_REALM_NAME,
        reason: 'bought tools and started a first woodworking project',
        itemIndexes: [0],
        narrative: 'Started a first woodworking project after buying a secondhand table saw.',
      },
      {
        name: JOB_SEARCH_ARC_NAME,
        realm: JOB_SEARCH_REALM_NAME,
        reason: 'quietly started job hunting after feeling stuck at the current job',
        itemIndexes: [1],
        narrative: 'Quietly started a job search after feeling stuck at the current job.',
      },
    ],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}

export const dayTwoTurns: FixtureTurn[] = [
  {
    user: 'I cut the pine boards for the bookshelf shelves today, slower going than I expected.',
    assistant: 'Slow is normal for a first project. How did the boards turn out?',
  },
  {
    user: 'Good enough. Also had a phone screen with a tech company today, I think it went well.',
    assistant: 'Two things moving at once. How are you holding up?',
  },
]

export const dayTwoRememberText = 'Phone screen felt encouraging, waiting to hear back'

export function dayTwoReflection(arcIds: ArcIds): ReflectionOutput {
  return {
    summary: 'Cut the shelf boards for the bookshelf and had an encouraging phone screen.',
    items: [
      { text: 'Cut the pine boards for the bookshelf shelves', kind: 'event' },
      { text: 'Had a phone screen with a tech company that went well', kind: 'event' },
    ],
    attributions: [
      { itemIndex: 0, arcId: arcIds.woodworking, confidence: 0.9 },
      { itemIndex: 1, arcId: arcIds.jobSearch, confidence: 0.9 },
    ],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}

export const dayThreeTurns: FixtureTurn[] = [
  {
    user: 'Sanded and stained the bookshelf boards today, almost ready for assembly.',
    assistant: 'It is coming together. Assembly next?',
  },
  {
    user: 'Yes. Also got a second interview scheduled after that phone screen.',
    assistant: 'Good momentum on both fronts this week.',
  },
]

export const dayThreeRememberText = 'Second interview scheduled for next week'

export function dayThreeReflection(arcIds: ArcIds): ReflectionOutput {
  return {
    summary: 'Sanded and stained the bookshelf, and scheduled a second interview.',
    items: [
      { text: 'Sanded and stained the bookshelf boards', kind: 'event' },
      { text: 'Scheduled a second interview after the phone screen went well', kind: 'event' },
    ],
    attributions: [
      { itemIndex: 0, arcId: arcIds.woodworking, confidence: 0.9 },
      { itemIndex: 1, arcId: arcIds.jobSearch, confidence: 0.9 },
    ],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}

export const dayOneRollupText =
  'Day one rollup: a secondhand table saw arrived, a first bookshelf project began, and a job search started quietly.'
export const dayTwoRollupText =
  'Day two rollup: shelf boards cut for the bookshelf, and an encouraging phone screen.'
export const dayThreeRollupText =
  'Day three rollup: the bookshelf sanded and stained, and a second interview scheduled.'

export const presentDayQuestion = 'Did I already buy the table saw for the bookshelf?'
export const presentDaySearchQuery = 'table saw'
export const presentDayAnswer =
  'Yes, you bought a secondhand table saw and started the bookshelf a few days ago.'

export function presentDayReflection(): ReflectionOutput {
  return {
    summary: 'Checked in about the bookshelf progress.',
    items: [],
    attributions: [],
    newArcs: [],
    newPersons: [],
    arcUpdates: [],
    personUpdates: [],
    constitutionUpdate: null,
  }
}
