import React, { useEffect, useState, useRef } from 'react';
import { chatStore, ChatMessage } from '../net/chat';
import { networkManager } from '../net/NetworkManager';

export const ChatLog = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(chatStore.getMessages());
  const [isInputVisible, setIsInputVisible] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateHandler = (msgs: ChatMessage[]) => {
      setMessages(msgs);
    };
    chatStore.on('update', updateHandler);
    return () => chatStore.off('update', updateHandler);
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Enter') {
        if (!isInputVisible) {
          e.preventDefault();
          setIsInputVisible(true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isInputVisible]);

  const handleInputChange = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.code === 'Enter') {
      if (inputValue.trim()) {
        networkManager.sendChat(inputValue);
        setInputValue('');
      }
      setIsInputVisible(false);
    } else if (e.code === 'Escape') {
      setIsInputVisible(false);
      setInputValue('');
    }
  };

  const formatTime = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        left: 20,
        width: 300,
        maxHeight: '40vh',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
        pointerEvents: 'auto',
        fontFamily: 'monospace',
        fontSize: '12px',
      }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          marginBottom: 10,
          color: '#ccc',
          textShadow: '1px 1px 1px #000',
        }}
      >
        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <span style={{ color: '#888' }}>[{formatTime(msg.ts)}]</span>{' '}
            <span style={{ color: '#fff', fontWeight: 'bold' }}>{msg.from}:</span>{' '}
            <span>{msg.text}</span>
          </div>
        ))}
      </div>
      {isInputVisible && (
        <input
          autoFocus
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleInputChange}
          style={{
            background: 'rgba(0,0,0,0.7)',
            border: '1px solid #444',
            color: '#fff',
            padding: '4px 8px',
            outline: 'none',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
        />
      )}
    </div>
  );
};
