import { useEffect, useRef, useState } from 'react'

export interface ChatMessage {
  id: string
  from: string
  text: string
  mine: boolean
}

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string) => void
  disabled?: boolean
}

/** Text chat side panel; auto-scrolls to the newest message. */
export function ChatPanel({ messages, onSend, disabled = false }: ChatPanelProps) {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <aside className="chat">
      <h2 className="chat__title">聊天室</h2>
      <div className="chat__log">
        {messages.length === 0 && <p className="chat__empty">還沒有訊息</p>}
        {messages.map((m) => (
          <div key={m.id} className={m.mine ? 'chat__msg chat__msg--mine' : 'chat__msg'}>
            <span className="chat__from">{m.mine ? '你' : m.from}</span>
            <span className="chat__text">{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="chat__form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={disabled ? '加入房間後即可聊天' : '輸入訊息…'}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled || !draft.trim()}>
          送出
        </button>
      </form>
    </aside>
  )
}
