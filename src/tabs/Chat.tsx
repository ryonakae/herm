import { memo } from "react"
import { MessageList } from "../components/chat/MessageList"
import type { PromptWire } from "../components/chat/MessageItem"
import { ThoughtCloud } from "../components/chat/ThoughtCloud"
import { useTheme } from "../theme"
import { usePref } from "../utils/preferences"
import type { Message } from "../types/message"

export const Chat = memo(({
  messages,
  streaming,
  prompt,
  cloud,
  cloudH,
  pick,
  onResize,
  onPick,
  onClose,
  onRewind,
}: {
  messages: Message[]
  streaming: boolean
  prompt?: PromptWire
  cloud: boolean
  cloudH: number
  pick?: Message
  onResize: (h: number) => void
  onPick: (m?: Message) => void
  onClose: () => void
  onRewind?: (m: Message) => void
}) => {
  const theme = useTheme().theme
  const inlineProcess = usePref("inlineProcess") ?? false
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      position="relative"
      backgroundColor={theme.background}
    >
      <MessageList messages={messages} streaming={streaming} prompt={prompt} onRewind={onRewind} onPick={onPick} />
      {cloud && !inlineProcess ? (
        <box position="absolute" top={0} left={0} right={0} zIndex={1}>
          <ThoughtCloud
            height={cloudH} messages={messages}
            pick={pick} onResize={onResize} onClose={onClose}
          />
        </box>
      ) : null}
    </box>
  )
})
