import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './Companion.css'
import { MAX_QUESTION_CHARS, MAX_USER_TURNS, checkQuestion } from './guard'

// The weather companion: a chat sheet over the map where you describe what
// you want to do outside, and the AI checks live forecasts, NEA data and air
// quality to say whether to go and what to watch out for. An open model on
// Groq does the reasoning, in netlify/functions/companion.ts; this streams its
// reply in.

const API = '/api/companion'

const SUGGESTIONS = [
  "I want a light 1-hour cycle at East Coast Park now, but the haze looks bad. Should I go?",
  'Hiking MacRitchie for 3 hours from now. Will I get caught in the rain?',
  'Picnic at the Botanic Gardens from 5 to 7pm. Any rain?',
  'Going for a 45 min run near me in half an hour. What should I watch out for?',
]

type Item = {
  id: number
  role: 'user' | 'assistant'
  text: string
  status?: string
  error?: string
  pending?: boolean
}

// Mirrors CompanionEvent in netlify/functions/companion.ts.
type CompanionEvent =
  | { type: 'status'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'turn'; messages: unknown[] }
  | { type: 'error'; message: string }

type Verdict = 'go' | 'care' | 'hold' | 'no'
const VERDICTS: Record<string, Verdict> = {
  go: 'go',
  'go with care': 'care',
  'hold off': 'hold',
  "don't go": 'no',
  'don’t go': 'no',
}

function IconSparkle({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M12 3.5c.6 3.9 2.6 5.9 6.5 6.5-3.9.6-5.9 2.6-6.5 6.5-.6-3.9-2.6-5.9-6.5-6.5 3.9-.6 5.9-2.6 6.5-6.5Z" />
      <path d="M19 15.5c.25 1.6 1 2.35 2.5 2.5-1.5.15-2.25.9-2.5 2.5-.25-1.6-1-2.35-2.5-2.5 1.5-.15 2.25-.9 2.5-2.5Z" />
    </svg>
  )
}

function IconClose({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function IconSend({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  )
}

function IconStop({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

// **bold** spans only; everything else stays plain text (React escapes it).
function inline(text: string): ReactNode[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))
}

// Renders the small Markdown subset the companion is told to use: an optional
// "Verdict:" first line, paragraphs, "- " bullets and **bold**.
function Reply({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let verdict: { kind: Verdict; label: string } | null = null
  let bullets: string[] = []
  let para: string[] = []

  const flush = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>)
      para = []
    }
    if (bullets.length) {
      blocks.push(
        <ul key={blocks.length}>
          {bullets.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      )
      bullets = []
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const v: RegExpExecArray | null = !verdict && blocks.length === 0 && para.length === 0 ? /^\**verdict:\s*(.+?)\**$/i.exec(line) : null
    if (v) {
      const label: string = v[1].replace(/\*+/g, '').trim()
      const kind: Verdict | undefined = VERDICTS[label.toLowerCase()]
      if (kind) {
        verdict = { kind, label }
        continue
      }
    }
    if (!line) {
      flush()
    } else if (/^[-•*]\s+/.test(line)) {
      if (para.length) flush()
      bullets.push(line.replace(/^[-•*]\s+/, ''))
    } else {
      if (bullets.length) flush()
      para.push(line)
    }
  }
  flush()

  return (
    <>
      {verdict && <div className={`cmp-verdict ${verdict.kind}`}>{verdict.label}</div>}
      {blocks}
    </>
  )
}

// One-shot position for this question. Resolves to null rather than failing
// so a denied or slow permission never blocks the answer.
function currentPosition(): Promise<GeolocationPosition | null> {
  if (!navigator.geolocation) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: false,
      timeout: 6000,
      maximumAge: 5 * 60 * 1000,
    })
  })
}

export default function Companion() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  // Why the last attempted question wasn't sent; cleared on the next edit.
  const [inputError, setInputError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [useLocation, setUseLocation] = useState(true)
  // The conversation exactly as the server returned it (including tool calls
  // and their results), replayed unchanged on the next question.
  const historyRef = useRef<unknown[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const nextId = useRef(1)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const updateItem = useCallback((id: number, patch: (item: Item) => Partial<Item>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch(it) } : it)))
  }, [])

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim()
      if (!q || busy) return
      // Checked here too so a refused question costs no request and stays in
      // the box to fix; the server applies the same rules regardless.
      const refusal =
        checkQuestion(q) ??
        (items.filter((it) => it.role === 'user').length >= MAX_USER_TURNS
          ? 'This chat has reached its limit. Start a new chat to keep going.'
          : null)
      if (refusal) {
        setInput(q)
        setInputError(refusal)
        return
      }
      setInputError(null)
      setInput('')
      setBusy(true)
      const userId = nextId.current++
      const replyId = nextId.current++
      setItems((list) => [
        ...list,
        { id: userId, role: 'user', text: q },
        { id: replyId, role: 'assistant', text: '', pending: true, status: useLocation ? 'Getting your location' : 'Thinking' },
      ])

      const abort = new AbortController()
      abortRef.current = abort
      try {
        const pos = useLocation ? await currentPosition() : null
        updateItem(replyId, () => ({ status: 'Thinking' }))
        const res = await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            history: historyRef.current,
            question: q,
            context: {
              time: new Date().toString(),
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              location: pos
                ? { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy_m: pos.coords.accuracy }
                : undefined,
            },
          }),
        })
        if (!res.ok || !res.body) {
          const j = await res.json().catch(() => null)
          throw new Error(j?.error ?? `The companion is unavailable (${res.status}).`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        // Text from separate model turns (before and after a lookup) gets a
        // paragraph break instead of running together.
        let needsBreak = false
        const handle = (event: CompanionEvent) => {
          switch (event.type) {
            case 'status':
              needsBreak = true
              updateItem(replyId, () => ({ status: event.text }))
              break
            case 'text': {
              const lead = needsBreak ? '\n\n' : ''
              needsBreak = false
              updateItem(replyId, (it) => ({ text: it.text ? it.text + lead + event.delta : event.delta, status: undefined }))
              break
            }
            case 'turn':
              historyRef.current = [...historyRef.current, ...event.messages]
              break
            case 'error':
              updateItem(replyId, () => ({ error: event.message }))
              break
          }
        }
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) handle(JSON.parse(line))
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          updateItem(replyId, () => ({ error: e instanceof Error ? e.message : 'Something went wrong.' }))
        }
      } finally {
        updateItem(replyId, (it) => ({
          pending: false,
          status: undefined,
          error: it.error ?? (abort.signal.aborted && !it.text ? 'Stopped.' : undefined),
        }))
        abortRef.current = null
        setBusy(false)
      }
    },
    [busy, items, useLocation, updateItem],
  )

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    historyRef.current = []
    setItems([])
    setInputError(null)
    inputRef.current?.focus()
  }, [])

  return (
    <>
      <button className="cmp-launcher" onClick={() => setOpen(true)} aria-label="Ask the weather companion">
        <IconSparkle />
        <span>Ask</span>
      </button>

      <div className={`cmp-scrim${open ? ' open' : ''}`} onClick={() => setOpen(false)} aria-hidden="true" />
      <section className={`cmp-sheet${open ? ' open' : ''}`} aria-label="Weather companion" aria-hidden={!open}>
        <header className="cmp-header">
          <div className="cmp-title">
            <IconSparkle size={15} />
            <span>Weather companion</span>
          </div>
          <div className="cmp-header-actions">
            {items.length > 0 && (
              <button className="cmp-text-btn" onClick={newChat}>
                New chat
              </button>
            )}
            <button className="cmp-icon-btn" onClick={() => setOpen(false)} aria-label="Close">
              <IconClose />
            </button>
          </div>
        </header>

        <div className="cmp-scroll" ref={scrollRef}>
          {items.length === 0 ? (
            <div className="cmp-empty">
              <p className="cmp-empty-lead">
                Tell me what you want to do outside, where, and for how long. I'll check live rain, haze and heat and
                tell you whether to go, and how to stay safe if you do.
              </p>
              <div className="cmp-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="cmp-suggestion" onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((it) =>
              it.role === 'user' ? (
                <div key={it.id} className="cmp-msg user">
                  {it.text}
                </div>
              ) : (
                <div key={it.id} className="cmp-msg assistant" aria-live="polite">
                  {it.text && <Reply text={it.text} />}
                  {it.status && (
                    <div className="cmp-status">
                      <span className="cmp-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      {it.status}
                    </div>
                  )}
                  {it.error && <div className="cmp-error">{it.error}</div>}
                </div>
              ),
            )
          )}
        </div>

        <form
          className="cmp-composer"
          onSubmit={(e) => {
            e.preventDefault()
            ask(input)
          }}
        >
          <textarea
            ref={inputRef}
            className="cmp-input"
            rows={1}
            value={input}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="e.g. 2h cycle at Punggol from 4pm?"
            aria-invalid={inputError ? true : undefined}
            aria-describedby={inputError ? 'cmp-input-note' : undefined}
            onChange={(e) => {
              setInput(e.target.value)
              setInputError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                ask(input)
              }
            }}
          />
          {busy ? (
            <button type="button" className="cmp-send" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <IconStop />
            </button>
          ) : (
            <button type="submit" className="cmp-send" disabled={!input.trim()} aria-label="Send">
              <IconSend />
            </button>
          )}
        </form>
        {inputError ? (
          <div id="cmp-input-note" className="cmp-input-note error" role="alert">
            {inputError}
          </div>
        ) : (
          input.length > MAX_QUESTION_CHARS - 100 && (
            <div className="cmp-input-note">
              {input.length}/{MAX_QUESTION_CHARS}
            </div>
          )
        )}
        <label className="cmp-location">
          <input type="checkbox" checked={useLocation} onChange={(e) => setUseLocation(e.target.checked)} />
          Share my location, for questions about "here" or "near me"
        </label>
      </section>
    </>
  )
}
