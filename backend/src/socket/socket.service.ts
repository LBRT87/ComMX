import { Injectable } from '@nestjs/common';
import { Server } from 'socket.io';

@Injectable()
export class SocketService {
  async getActiveRooms(server: Server): Promise<string[]> {
    const sockets = await server.fetchSockets();
    const socketIds = new Set(sockets.map((socket) => socket.id));

    const rooms = new Set<string>();
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (!socketIds.has(room)) {
          rooms.add(room);
        }
      }
    }

    return [...rooms].sort();
  }
}
