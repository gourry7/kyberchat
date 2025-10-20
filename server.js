const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      }
      // Avoid stale kyber files during development
      res.setHeader('Cache-Control', 'no-store');
    },
  })
);

// 클라이언트의 공개키를 저장
const clientKeys = new Map();

wss.on('connection', (ws) => {
  console.log('Client connected. Total clients:', wss.clients.size);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received JSON message:', data.type);
      
      // 공개키 수신 시 저장하고 브로드캐스트
      if (data.type === 'pubkey') {
        clientKeys.set(ws, data);
        console.log('Stored public key. Total keys:', clientKeys.size);
        
        // 새 클라이언트에게 기존 클라이언트들의 공개키 전송
        clientKeys.forEach((keyData, client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(keyData));
          }
        });
        
        // 기존 클라이언트들에게 새 클라이언트의 공개키 전송
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message.toString());
          }
        });
      } else if (data.type === 'message' || data.type === 'kyber_ct' || data.type === 'encrypted_message') {
        // 메시지는 모든 클라이언트에게 전달 (자신 제외)
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message.toString());
          }
        });
      } else {
        // 기타 메시지 처리
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(message.toString());
          }
        });
      }
    } catch (error) {
      // JSON이 아닌 경우
      const messageStr = message.toString();
      console.log('Non-JSON message received');
      
      if (messageStr.length < 2) {
        return;
      }
      
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(messageStr);
        }
      });
    }
  });

  ws.on('close', () => {
    clientKeys.delete(ws);
    console.log('Client disconnected. Total clients:', wss.clients.size, 'Total keys:', clientKeys.size);
  });
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Server started on http://0.0.0.0:3000');
  console.log('Local access: http://localhost:3000');
  console.log('Network access: http://172.30.1.30:3000');
});
