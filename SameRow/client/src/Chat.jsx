import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FaArrowDown, FaComments, FaPaperPlane, FaTimes } from 'react-icons/fa';
import Dialog from './components/Dialog';
import './Chat.css';

const EMPTY_MESSAGES = [];
const compactQuery = '(max-width: 1099px)';
const subscribeToWidth = (callback) => {
  const mediaQuery = window.matchMedia(compactQuery);
  mediaQuery.addEventListener('change', callback);
  return () => mediaQuery.removeEventListener('change', callback);
};
const getCompactSnapshot = () => window.matchMedia(compactQuery).matches;
const getServerSnapshot = () => false;

function messageTime(value) {
  const date = value?.toDate?.() ?? (value instanceof Date ? value : Number.isFinite(value) ? new Date(value) : null);
  return date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

export default function Chat({ socket, roomId, userName, onClose, open = true, onUnreadChange, preview = false, previewMessages = EMPTY_MESSAGES }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const pendingMessage = useRef(null);
  const requestHistory = useRef(null);
  const isCompact = useSyncExternalStore(subscribeToWidth, getCompactSnapshot, getServerSnapshot);
  const messagesRef = useRef(null);
  const composerRef = useRef(null);
  const isAtBottom = useRef(true);
  const scrollPosition = useRef(0);
  const unread = useRef(0);
  const current = useRef({ open, userName, onUnreadChange });
  const displayedMessages = preview ? [...previewMessages, ...messages] : messages;

  useEffect(() => {
    current.current = { open, userName, onUnreadChange };
    if (open) {
      unread.current = 0;
      onUnreadChange?.(0);
    }
  }, [open, userName, onUnreadChange]);

  useEffect(() => {
    if (!roomId || preview || !socket) return;
    let disposed = false;
    const knownIds = new Set();
    const merge = (previous, incoming) => [...new Map([...previous, ...incoming].map(message => [message.id, message])).values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-1000);
    const history = before => {
      if (!socket.connected || disposed) return;
      setLoadingHistory(true);
      socket.timeout(10000).emit('chat-history', { roomId, before }, (error, reply) => {
        if (disposed) return;
        setLoadingHistory(false);
        if (error || reply?.error) { setError(reply?.error || 'Chat could not connect. Reconnect and try again.'); return; }
        for (const message of reply.messages || []) knownIds.add(message.id);
        setMessages(previous => merge(previous, reply.messages || []));
        setHasMore(!!reply.hasMore); setError('');
      });
    };
    requestHistory.current = history;
    const received = message => {
      if (disposed || !message?.id) return;
      if (knownIds.has(message.id)) return;
      knownIds.add(message.id);
      if (knownIds.size > 2000) knownIds.delete(knownIds.values().next().value);
      const mine = message.senderId ? message.senderId === socket.sessionUid : message.sender === current.current.userName;
      setMessages(previous => merge(previous, [message]));
      if (!current.current.open && !mine) { unread.current += 1; current.current.onUnreadChange?.(unread.current); }
      if (current.current.open && !isAtBottom.current) setHasNewMessages(true);
    };
    const ready = () => history();
    socket.on('chat-message', received); socket.on('room-ready', ready);
    const initial = setTimeout(ready, 0);
    return () => {
      disposed = true; clearTimeout(initial); requestHistory.current = null;
      socket.off('chat-message', received); socket.off('room-ready', ready);
    };
  }, [roomId, preview, socket]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const area = messagesRef.current;
      if (!area) return;
      area.scrollTop = isAtBottom.current ? area.scrollHeight : scrollPosition.current;
    });
    return () => cancelAnimationFrame(frame);
  }, [open, isCompact, messages, previewMessages]);

  useEffect(() => {
    if (!open || isCompact) return;
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open, isCompact]);

  const scrollToLatest = () => {
    const area = messagesRef.current;
    if (area) area.scrollTop = area.scrollHeight;
    isAtBottom.current = true;
    setHasNewMessages(false);
  };

  const handleScroll = () => {
    const area = messagesRef.current;
    if (!area) return;
    scrollPosition.current = area.scrollTop;
    isAtBottom.current = area.scrollHeight - area.scrollTop - area.clientHeight < 72;
    if (isAtBottom.current) setHasNewMessages(false);
  };

  const handleSend = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending || (!roomId && !preview)) return;
    setSending(true);
    setError('');
    isAtBottom.current = true;
    try {
      if (preview) {
        setMessages((previous) => [...previous, { id: `preview-${Date.now()}`, text, sender: userName, createdAt: new Date() }]);
      } else {
        if (!socket?.connected) throw new Error('Wait for the room to reconnect.');
        if (pendingMessage.current?.text !== text) pendingMessage.current = { id: crypto.randomUUID(), text };
        const reply = await new Promise((resolve, reject) => socket.timeout(10000).emit('chat-send', { roomId, ...pendingMessage.current }, (error, result) => error ? reject(error) : resolve(result)));
        if (reply?.error) throw new Error(reply.error);
        pendingMessage.current = null;
      }
      // Keep any edits made while this message was being sent.
      setDraft((value) => value.trim() === text ? '' : value);
      setHasNewMessages(false);
    } catch (error) {
      setError(error.message || 'Message was not sent. Your draft is saved; try again.');
    } finally {
      setSending(false);
    }
  };

  const content = (
    <div className="sr-chat-panel">
      <div className="sr-chat-conversation">
        {!preview && hasMore && <button className="sr-chat-new" type="button" disabled={loadingHistory} onClick={() => { isAtBottom.current = false; requestHistory.current?.(messages[0]?.id); }}>{loadingHistory ? 'Loading…' : 'Load earlier messages'}</button>}
        <div className="sr-chat-messages" ref={messagesRef} onScroll={handleScroll} role="log" aria-label="Room messages" aria-live={open ? 'polite' : 'off'} aria-relevant="additions" tabIndex={0}>
          {displayedMessages.length === 0 ? (
            <div className="sr-chat-empty">
              <span className="sr-chat-empty-icon"><FaComments aria-hidden="true" /></span>
              <strong>No messages yet</strong>
              <p>Send a message to everyone in the room.</p>
            </div>
          ) : displayedMessages.map((message) => {
            const mine = message.senderId ? message.senderId === socket?.sessionUid : message.sender === userName;
            const time = messageTime(message.createdAt);
            return (
              <div key={message.id} className={`sr-chat-message${mine ? ' is-mine' : ''}`}>
                <div className="sr-chat-message-meta"><span>{mine ? 'You' : message.sender || 'Guest'}</span>{time && <time>{time}</time>}</div>
                <div className="sr-chat-bubble">{message.text}</div>
              </div>
            );
          })}
        </div>
        {hasNewMessages && <button className="sr-chat-new" type="button" onClick={scrollToLatest}><FaArrowDown aria-hidden="true" /> New messages</button>}
      </div>
      {error && <p className="sr-chat-error" role="alert">{error}</p>}
      <form className="sr-chat-composer" onSubmit={handleSend}>
        <label className="sr-visually-hidden" htmlFor="room-chat-message">Message everyone</label>
        <input id="room-chat-message" ref={composerRef} className="sr-chat-input" placeholder="Message everyone…" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} autoComplete="off" data-autofocus />
        <button className="sr-chat-send" type="submit" aria-label={sending ? 'Sending message' : 'Send message'} disabled={!draft.trim() || sending || (!roomId && !preview)}><FaPaperPlane aria-hidden="true" /></button>
      </form>
      <p className="sr-chat-hint">Visible to everyone in this room</p>
    </div>
  );

  return (
    <aside className={`sr-chat-container${open ? ' open' : ''}`} hidden={!open} aria-label="Room chat">
      {isCompact ? (
        <Dialog open={open} title="Room chat" onClose={onClose} className="sr-chat-dialog">{content}</Dialog>
      ) : (
        <>
          <header className="sr-chat-header"><div><h2>Room chat</h2></div><button className="sr-chat-close" type="button" onClick={onClose} aria-label="Close chat"><FaTimes aria-hidden="true" /></button></header>
          {content}
        </>
      )}
    </aside>
  );
}
