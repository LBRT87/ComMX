"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import type { ChatEntry, ChatMessage, RoomPresence } from "../lib/types";

interface ChatViewProps {
  socket: Socket;
  roomId: string;
  username: string;
  onLeave: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

let entryCounter = 0;
const nextId = () => `e${entryCounter++}`;

export default function ChatView({
  socket,
  roomId,
  username,
  onLeave,
}: ChatViewProps) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    socket.emit("joinRoom", roomId);

    const onMessage = (msg: ChatMessage) => {
      setEntries((prev) => [...prev, { kind: "message", id: nextId(), ...msg }]);
    };
    const onJoined = (p: RoomPresence) => {
      setEntries((prev) => [
        ...prev,
        {
          kind: "system",
          id: nextId(),
          text: `${p.username} joined the room`,
          timestamp: new Date().toISOString(),
        },
      ]);
    };
    const onLeft = (p: RoomPresence) => {
      setEntries((prev) => [
        ...prev,
        {
          kind: "system",
          id: nextId(),
          text: `${p.username} left the room`,
          timestamp: new Date().toISOString(),
        },
      ]);
    };

    socket.on("roomMessage", onMessage);
    socket.on("userJoined", onJoined);
    socket.on("userLeft", onLeft);

    return () => {
      socket.emit("leaveRoom", roomId);
      socket.off("roomMessage", onMessage);
      socket.off("userJoined", onJoined);
      socket.off("userLeft", onLeft);
    };
  }, [socket, roomId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  function handleSend(event: React.FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message) return;
    socket.emit("roomMessage", { roomId, message });
    setDraft("");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-6">
      <div className="animate-view-in flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-neutral-100 px-6 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-neutral-400">
              Room
            </p>
            <h1 className="font-mono text-lg font-semibold text-neutral-800">
              {roomId}
            </h1>
          </div>
          <button
            onClick={onLeave}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            ← Leave
          </button>
        </header>

        <div
          ref={scrollRef}
          className="subtle-scroll flex-1 space-y-3 overflow-y-auto bg-neutral-50 px-6 py-4"
        >
          {entries.length === 0 && (
            <p className="pt-10 text-center text-sm text-neutral-400">
              No messages yet. Say hello!
            </p>
          )}

          {entries.map((entry) => {
            if (entry.kind === "system") {
              return (
                <p
                  key={entry.id}
                  className="text-center text-xs text-neutral-400"
                >
                  {entry.text}
                </p>
              );
            }

            const isOwn = entry.userId === socket.id;
            return (
              <div
                key={entry.id}
                className={`flex flex-col ${isOwn ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                    isOwn
                      ? "rounded-br-sm bg-neutral-800 text-neutral-50"
                      : "rounded-bl-sm border border-neutral-200 bg-white text-neutral-800"
                  }`}
                >
                  {!isOwn && (
                    <p className="mb-0.5 text-xs font-medium text-neutral-500">
                      {entry.username}
                    </p>
                  )}
                  <p className="break-words text-sm">{entry.message}</p>
                </div>
                <span className="mt-1 px-1 text-[10px] text-neutral-400">
                  {isOwn ? "You" : entry.username} · {formatTime(entry.timestamp)}
                </span>
              </div>
            );
          })}
        </div>

        <form
          onSubmit={handleSend}
          className="flex items-center gap-2 border-t border-neutral-100 p-4"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Message #${roomId}`}
            className="flex-1 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-neutral-800 placeholder-neutral-400 outline-none transition focus:border-neutral-400 focus:bg-white"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-xl bg-neutral-800 px-5 py-3 font-medium text-neutral-50 transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
