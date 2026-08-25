import {
  WebSocketGateway,
  SubscribeMessage,
  OnGatewayDisconnect,
  OnGatewayConnection,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { SocketService } from './socket.service';
import { JwtService } from '@nestjs/jwt';
import * as cookie from 'cookie';

@WebSocketGateway({
  transports: ['websocket'],
  cors: {
    origin: process.env.SOCKET_ORIGIN!,
    credentials: true,
  },
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SocketGateway.name);

  constructor(
    private readonly socketService: SocketService,
    private readonly jwtService: JwtService,
  ) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway Initialized');

    server.use((client: Socket, next) => {
      const cookieString = client.handshake.headers.cookie;

      if (!cookieString) {
        return next(new Error('Unauthorized: Missing Authorization header'));
      }

      const cookies = cookie.parse(cookieString);

      const token = cookies['access_token'];

      if (!token) {
        return next(new Error('Unauthorized: No token provided'));
      }

      try {
        const payload = this.jwtService.verify(token, {
          secret: process.env.JWT_SECRET!,
        });

        client.data.userId = payload.userId;
        client.data.username = payload.username;

        next();
      } catch (error) {
        return next(new Error('Unauthorized: Invalid or expired token'));
      }
    });
  }

  async handleConnection(client: Socket) {
    const username = client.data.username;

    this.logger.log(`Client connected: ${client.id} (${username})`);

    client.on('disconnecting', () => {
      for (const room of client.rooms) {
        if (room !== client.id) {
          client.to(room).emit('userLeft', {
            userId: client.id,
            username: client.data.username,
            roomId: room,
          });
        }
      }
    });

    client.emit(
      'roomList',
      await this.socketService.getActiveRooms(this.server),
    );
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    await this.broadcastRooms();
  }

  @SubscribeMessage('getRooms')
  async handleGetRooms() {
    return this.socketService.getActiveRooms(this.server);
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @MessageBody() roomId: string,
    @ConnectedSocket() client: Socket,
  ) {
    await client.join(roomId);

    client.to(roomId).emit('userJoined', {
      userId: client.id,
      username: client.data.username,
      roomId,
    });

    await this.broadcastRooms();

    return { joined: roomId };
  }

  @SubscribeMessage('leaveRoom')
  async handleLeaveRoom(
    @MessageBody() roomId: string,
    @ConnectedSocket() client: Socket,
  ) {
    await client.leave(roomId);

    client.to(roomId).emit('userLeft', {
      userId: client.id,
      username: client.data.username,
      roomId,
    });

    await this.broadcastRooms();

    return { left: roomId };
  }

  @SubscribeMessage('roomMessage')
  handleRoomMessage(
    @MessageBody() data: { roomId: string; message: string },
    @ConnectedSocket() client: Socket,
  ) {
    if (!client.rooms.has(data.roomId)) {
      return { error: 'Not a member of this room' };
    }

    this.server.to(data.roomId).emit('roomMessage', {
      userId: client.id,
      username: client.data.username,
      roomId: data.roomId,
      message: data.message,
      timestamp: new Date().toISOString(),
    });

    return { sent: true };
  }

  private async broadcastRooms() {
    const rooms = await this.socketService.getActiveRooms(this.server);
    this.server.emit('roomList', rooms);
  }
}
