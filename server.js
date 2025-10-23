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

// 클라이언트 정보를 저장 (공개키 + 사용자 정보)
const clientKeys = new Map();
const connectedUsers = new Map(); // 사용자 ID -> 사용자 정보
const activeChats = new Map(); // 대화방 ID -> 대화 참여자들
let nextUserId = 1;

// userId가 현재 사용 중인지 확인하는 헬퍼 함수
function isUserIdInUse(userId) {
  return connectedUsers.has(userId);
}

wss.on('connection', (ws) => {
  console.log('Client connected. Total clients:', wss.clients.size);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('Received JSON message:', data.type);
      
      // 공개키 수신 시 저장하고 브로드캐스트
      if (data.type === 'pubkey') {
        // 사용자 ID 할당 또는 재사용
        if (!ws.userId) {
          // 클라이언트가 저장된 userId를 보냈다면 재사용, 아니면 새로 생성
          if (data.savedUserId && !isUserIdInUse(data.savedUserId)) {
            ws.userId = data.savedUserId;
            console.log(`기존 userId 재사용: ${ws.userId}`);
          } else {
            ws.userId = `user_${nextUserId++}`;
            console.log(`새로운 userId 할당: ${ws.userId}`);
          }
          ws.username = data.username || `사용자${nextUserId - 1}`;
        }
        
        clientKeys.set(ws, data);
        connectedUsers.set(ws.userId, {
          userId: ws.userId,
          username: ws.username,
          publicKey: data.key,
          connected: true,
          inChat: false,
          chatWith: null
        });
        
        console.log(`User ${ws.username} (${ws.userId}) connected. Total users:`, connectedUsers.size);
        
        // 클라이언트에게 사용자 ID 전송
        ws.send(JSON.stringify({
          type: 'user_id',
          userId: ws.userId,
          username: ws.username
        }));
        
        // 모든 클라이언트에게 사용자 목록 업데이트 전송
        broadcastUserListUpdate();
        
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
      } else if (data.type === 'request_chat') {
        // 대화 요청
        const { targetUserId } = data;
        const targetUser = connectedUsers.get(targetUserId);
        const currentUser = connectedUsers.get(ws.userId);
        
        if (!targetUser || !currentUser) {
          ws.send(JSON.stringify({
            type: 'chat_error',
            message: '사용자를 찾을 수 없습니다.'
          }));
          return;
        }
        
        // 대상 사용자가 이미 대화 중인지 확인
        if (targetUser.inChat) {
          ws.send(JSON.stringify({
            type: 'chat_error',
            message: `${targetUser.username}은 이미 다른 사용자와 대화 중입니다.`
          }));
          return;
        }
        
        // 요청자가 이미 대화 중인지 확인
        if (currentUser.inChat) {
          ws.send(JSON.stringify({
            type: 'chat_error',
            message: '이미 다른 사용자와 대화 중입니다.'
          }));
          return;
        }
        
        // 대상 사용자에게 대화 요청 전송
        wss.clients.forEach((client) => {
          if (client.userId === targetUserId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'chat_request',
              fromUserId: ws.userId,
              fromUsername: currentUser.username,
              requestId: `${ws.userId}_${targetUserId}_${Date.now()}`
            }));
          }
        });
        
        // 요청자에게 요청 전송 완료 알림
        ws.send(JSON.stringify({
          type: 'chat_request_sent',
          message: `${targetUser.username}에게 대화 요청을 보냈습니다.`
        }));
        
      } else if (data.type === 'accept_chat') {
        // 대화 요청 수락
        const { requestId, fromUserId } = data;
        const targetUser = connectedUsers.get(fromUserId);
        const currentUser = connectedUsers.get(ws.userId);
        
        if (!targetUser || !currentUser) {
          ws.send(JSON.stringify({
            type: 'chat_error',
            message: '사용자를 찾을 수 없습니다.'
          }));
          return;
        }
        
        // 두 사용자 모두 대화 중 상태로 설정
        currentUser.inChat = true;
        currentUser.chatWith = fromUserId;
        targetUser.inChat = true;
        targetUser.chatWith = ws.userId;
        
        // 대화방 생성 (항상 작은 userId를 앞에 두어 일관성 유지)
        const userIds = [fromUserId, ws.userId].sort();
        const chatId = `${userIds[0]}_${userIds[1]}`;
        console.log(`대화방 생성: ${chatId} (${targetUser.username} -> ${currentUser.username})`);
        activeChats.set(chatId, {
          chatId,
          participants: [fromUserId, ws.userId],
          startTime: new Date()
        });
        
        // 두 사용자에게 대화 시작 알림
        ws.send(JSON.stringify({
          type: 'chat_started',
          chatId,
          targetUser: { userId: fromUserId, username: targetUser.username }
        }));
        
        wss.clients.forEach((client) => {
          if (client.userId === fromUserId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'chat_started',
              chatId,
              targetUser: { userId: ws.userId, username: currentUser.username }
            }));
          }
        });
        
        // 모든 클라이언트에게 사용자 목록 업데이트
        broadcastUserListUpdate();
        
      } else if (data.type === 'reject_chat') {
        // 대화 요청 거절
        const { fromUserId } = data;
        const targetUser = connectedUsers.get(fromUserId);
        
        if (targetUser) {
          wss.clients.forEach((client) => {
            if (client.userId === fromUserId && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'chat_rejected',
                message: `${connectedUsers.get(ws.userId).username}이 대화 요청을 거절했습니다.`
              }));
            }
          });
        }
        
      } else if (data.type === 'end_chat') {
        // 대화 종료 요청
        const currentUser = connectedUsers.get(ws.userId);
        if (currentUser && currentUser.inChat) {
          const targetUserId = currentUser.chatWith;
          const targetUser = connectedUsers.get(targetUserId);
          
          if (targetUser) {
            targetUser.inChat = false;
            targetUser.chatWith = null;
          }
          
          currentUser.inChat = false;
          currentUser.chatWith = null;
          
          // 대화방 제거
          const chatId = `${ws.userId}_${targetUserId}`;
          activeChats.delete(chatId);
          
          // 두 사용자에게 대화 종료 알림
          ws.send(JSON.stringify({
            type: 'chat_ended'
          }));
          
          wss.clients.forEach((client) => {
            if (client.userId === targetUserId && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'chat_ended'
              }));
            }
          });
          
          // 모든 클라이언트에게 사용자 목록 업데이트
          broadcastUserListUpdate();
        }
        
      } else if (data.type === 'message' || data.type === 'kyber_ct' || data.type === 'encrypted_message') {
        // 선택된 사용자에게만 메시지 전달 (1:1 채팅)
        if (data.targetUserId) {
          // 특정 사용자에게 전송
          wss.clients.forEach((client) => {
            if (client.userId === data.targetUserId && client.readyState === WebSocket.OPEN) {
              client.send(message.toString());
            }
          });
        } else {
          // 기존 방식: 모든 클라이언트에게 전달 (자신 제외)
          wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(message.toString());
            }
          });
        }
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
    // 사용자 정보 제거 및 대화 상태 정리
    if (ws.userId) {
      const user = connectedUsers.get(ws.userId);
      if (user && user.inChat) {
        // 대화 중이었다면 상대방에게 대화 종료 알림
        const targetUserId = user.chatWith;
        const targetUser = connectedUsers.get(targetUserId);
        
        if (targetUser) {
          targetUser.inChat = false;
          targetUser.chatWith = null;
          
          wss.clients.forEach((client) => {
            if (client.userId === targetUserId && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'chat_ended'
              }));
            }
          });
        }
      }
      
      connectedUsers.delete(ws.userId);
      console.log(`User ${ws.username} (${ws.userId}) disconnected.`);
    }
    
    clientKeys.delete(ws);
    console.log('Client disconnected. Total clients:', wss.clients.size, 'Total users:', connectedUsers.size);
    
    // 모든 클라이언트에게 사용자 목록 업데이트 전송
    broadcastUserListUpdate();
  });
});

// 사용자 목록 업데이트 브로드캐스트 함수
function broadcastUserListUpdate() {
  const userListUpdate = {
    type: 'user_list_update',
    users: Array.from(connectedUsers.values())
  };
  
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(userListUpdate));
    }
  });
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on http://0.0.0.0:${PORT}`);
  console.log(`Local access: http://localhost:${PORT}`);
});
