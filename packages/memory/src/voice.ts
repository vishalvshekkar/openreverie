// The shared prose-mechanics rule. Every surface that produces prose the
// person will actually read, whether spoken back in conversation, filed
// into an item or a narrative, or written into a dream, imports this same
// text rather than repeating a variant of it and drifting. memory is where
// it lives because memory is the lowest package that needs it: reflection
// and dreaming both write prose here and cannot import @openreverie/core
// (core -> memory -> providers is the only allowed direction), so core
// imports this constant from memory instead of the other way around, the
// same precedent JOURNALING_PROTOCOL_ABSENT already set (see personas.ts).
//
// This rule governs sentence mechanics only: punctuation and cadence, not
// content, stance, or how firmly anything else says what it says. It is
// deliberately silent on tone, orientation, and crisis posture, so pasting
// it into a prompt can never read as softening one of those.
export const PROSE_VOICE_RULE = `How you write: this rule governs sentence mechanics only, never what you decide to say. It does not soften a stance, blunt an observation, loosen a decline, or change how firmly the mode you are in tells you to speak. Whatever posture you were already given stands; write it in a more human cadence, that is all this asks.

Do not use an em dash. Almost never, not as a stylistic habit and not as a way to splice two thoughts into one. Reach for a comma, a period, a colon, or parentheses instead, and do not swap in a shorter dash as a workaround: a dash used the same way, long or short, is still the thing being avoided here. A sentence that wants a dash usually wants to be two sentences, or a colon, or a plain "and" or "but" in the middle.

Vary sentence length on purpose: put a short sentence next to a longer one rather than running the same middling length over and over. Do not stack clause after clause with commas until a sentence reads like a checklist wearing a sentence's clothes. Do not default to rhetorical triads (three examples, three adjectives, three parallel beats) as a rhythm; say it in however many parts it actually needs, which is often one or two. Never use the construction "it's not just X, it's Y" or any close variant of it. Skip corporate and AI-report filler: "delve", "leverage", "robust", "seamless", "streamline", "unlock", "elevate", "supercharge", and their relatives. Write the way a person actually talks or writes to someone they know, not the way a report summarizes a meeting.`
