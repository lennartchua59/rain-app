// Input checks for the weather companion, shared by the chat UI (instant
// feedback, no request sent) and the server function (the check that counts,
// since anyone can post to it directly). They catch the obvious ways people
// try to use a free weather bot as a general-purpose AI: coding and writing
// jobs, "ignore your instructions", pasted documents and spam. The system
// prompt keeps the model on topic for anything subtler. Plain functions only,
// so this also runs on the server.

export const MAX_QUESTION_CHARS = 500
export const MIN_QUESTION_CHARS = 2
// User questions per conversation before a new chat is needed. Every turn
// resends the whole history (tool results included), so long chats cost the
// most quota.
export const MAX_USER_TURNS = 12

export const OFF_TOPIC_MESSAGE =
  'I can only help with weather and outdoor plans, like "Will it rain at Bedok from 5 to 7pm?"'

const OFF_TOPIC: RegExp[] = [
  // Attempts to override the companion's instructions.
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions?|prompts?|rules|guidelines)\b/i,
  /\b(system|developer|hidden)\s+(prompt|message|instructions?)\b/i,
  /\b(jailbreak|dan mode|developer mode)\b/i,
  /\b(you are now|pretend (to be|you are)|act as an?|role-?play)\b/i,
  // Writing and coding jobs.
  /\b(write|draft|compose|generate|create)\b.{0,30}\b(essay|poem|story|song|lyrics|code|script|program|email|letter|article|report|tweet|caption|resume|cv)\b/i,
  /\b(python|javascript|typescript|c\+\+|sql|html|css|regex|leetcode)\b/i,
  /```|<\/?script|\bfunction\s*\(|\bdef\s+\w+\s*\(|#include|\bconsole\.log\b/i,
  /\b(translate|paraphrase|proofread)\b/i,
  /\b(homework|assignment|exam question|tutorial question)\b/i,
]

// Returns why a question is refused, or null when it may be sent.
export function checkQuestion(raw: string): string | null {
  const q = raw.trim()
  if (q.length < MIN_QUESTION_CHARS) return 'Ask a question about the weather or your plans.'
  if (q.length > MAX_QUESTION_CHARS) {
    return `Keep it under ${MAX_QUESTION_CHARS} characters: what you're doing, where, when and for how long.`
  }
  if (/https?:\/\/|www\./i.test(q)) return "Links aren't supported. Just name the place."
  // Keyboard mashing, or a wall of symbols or emoji. Numbers and ordinary
  // punctuation are fine: "1.35, 103.82 at 10:30-12:00?" is a real question.
  const visible = q.replace(/\s/g, '')
  const junk = visible.replace(/[\p{L}\p{N}.,:;?!'"’()/\-+%°]/gu, '').length
  if (/(.)\1{9,}/u.test(visible) || (visible.length >= 12 && junk / visible.length > 0.3)) {
    return OFF_TOPIC_MESSAGE
  }
  if (OFF_TOPIC.some((re) => re.test(q))) return OFF_TOPIC_MESSAGE
  return null
}
