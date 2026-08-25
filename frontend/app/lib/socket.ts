import { io, type Socket } from "socket.io-client";

export function createSocket(username: string): Socket {
  const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL!.replace(/\/$/, "");

  return io(SOCKET_URL, {
    path: "/socket.io/",
    transports: ["websocket"],
    auth: { username },
    autoConnect: true,
    withCredentials: true,
  });
}
