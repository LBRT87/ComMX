"use client";

import { useCallback, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { createSocket } from "../lib/socket";
import LoginView from "./LoginView";
import LobbyView from "./LobbyView";
import ChatView from "./ChatView";
import { loginUsernameAndPassword } from "../api/api";

type View = "login" | "lobby" | "chat";

export default function ChatApp() {
  const [view, setView] = useState<View>("login");
  const [username, setUsername] = useState("");
  const [rooms, setRooms] = useState<string[]>([]);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const handleSocketConnection = (name: string) => {
    const s = createSocket(name);
    socketRef.current = s;

    s.on("connect", () => {
      setConnecting(false);
      setUsername(name);
      setSocket(s);
      setView("lobby");
    });

    s.on("roomList", (list: string[]) => setRooms(list));

    s.on("connect_error", () => {
      setConnecting(false);
      setError("Could not reach the chat server. Please try again.");
      s.disconnect();
      socketRef.current = null;
    });
  };

  const handleLogin = useCallback((username: string, password: string) => {
    setConnecting(true);
    setError(null);

    loginUsernameAndPassword(username, password)
      .then(() => {
        handleSocketConnection(username);
      })
      .catch((err) => {
        setError(err.message);
        setConnecting(false);
      });
  }, []);

  const refreshRooms = useCallback(() => {
    socketRef.current?.emit("getRooms", (list: string[]) => setRooms(list));
  }, []);

  const joinRoom = useCallback((roomId: string) => {
    setCurrentRoom(roomId);
    setView("chat");
  }, []);

  const createRoom = useCallback(() => {
    const roomId = crypto.randomUUID().slice(0, 8);
    joinRoom(roomId);
  }, [joinRoom]);

  const leaveRoom = useCallback(() => {
    setCurrentRoom(null);
    setView("lobby");
    socketRef.current?.emit("getRooms", (list: string[]) => setRooms(list));
  }, []);

  const logout = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    setSocket(null);
    setRooms([]);
    setCurrentRoom(null);
    setUsername("");
    setView("login");
  }, []);

  if (view === "chat" && socket && currentRoom) {
    return (
      <ChatView
        socket={socket}
        roomId={currentRoom}
        username={username}
        onLeave={leaveRoom}
      />
    );
  }

  if (view === "lobby" && socket) {
    return (
      <LobbyView
        username={username}
        rooms={rooms}
        onJoin={joinRoom}
        onCreate={createRoom}
        onRefresh={refreshRooms}
        onLogout={logout}
      />
    );
  }

  return (
    <LoginView onSubmit={handleLogin} connecting={connecting} error={error} />
  );
}
