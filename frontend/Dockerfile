FROM node:20-alpine AS builder 
WORKDIR /app 
ARG NEXT_PUBLIC_SOCKET_URL 
ARG NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL 
COPY package*.json ./
RUN npm ci 
COPY . . 
RUN npm run build 

FROM node:20-alpine
WORKDIR /app 
ENV NODE_ENV=production
COPY --from=builder /app/public ./public 
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static 
EXPOSE 3000
CMD ["node","server.js"] 

