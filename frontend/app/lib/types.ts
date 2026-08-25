export interface ChatMessage {
  userId: string;
  username: string;
  roomId: string;
  message: string;
  timestamp: string;
}

export interface RoomPresence {
  userId: string;
  username: string;
  roomId: string;
}

export type ChatEntry =
  | ({ kind: "message"; id: string } & ChatMessage)
  | { kind: "system"; id: string; text: string; timestamp: string };
