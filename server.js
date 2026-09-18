const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin SDK
const admin = require('firebase-admin');
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', err);
  }
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (err) {
    console.warn('⚠️ Warning: serviceAccountKey.json not found. Set FIREBASE_SERVICE_ACCOUNT_JSON environment variable.');
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || 'juicy1-96e7b'
  });
  console.log('✅ Firebase Admin SDK initialized');
} else {
  try {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || 'juicy1-96e7b'
    });
    console.log('✅ Firebase Admin SDK initialized with default credentials');
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', err);
  }
}
const http = require('http');
const { Server } = require('socket.io');
const Message = require('./models/Message');
const User = require('./models/User');
// 🔔 FCM Push Notification service — sends push when app is in background/killed
const { sendMessageNotification, sendCallNotification, sendNotificationToUser } = require('./services/pushNotificationService');

const app = express();

// Enhanced CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or Capacitor)
    if (!origin) {
      return callback(null, true);
    }

    // List of allowed origins
    const allowedOrigins = [
      'http://localhost',
      'https://localhost',
      'http://localhost:3000',
      'http://localhost:5000',
      'capacitor://localhost',
      'https://juicee-30ie.onrender.com/',
      'https://juicyapp.in//',
      'https://juicee-30ie.onrender.com',
      'https://juicyapp.in/',
      'https://juicyapp.in',
      'https://juicy.lcind.space',
      'https://juicyapp.in/',
      process.env.FRONTEND_URL || 'http://localhost:3000'
    ];

    // Allow all localhost IPs (for mobile testing on same network)
    if (origin.includes('localhost') || origin.match(/^http:\/\/127\.0\.0\.\d+/) || origin.match(/^http:\/\/192\.168\.\d+\.\d+/) || origin.match(/^http:\/\/10\.\d+\.\d+\.\d+/)) {
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
};

app.use(cors(corsOptions));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static('uploads'));

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) { fs.mkdirSync(uploadsDir); }

// Replace ad-hoc connect + start with an async bootstrap that waits for DB
async function startServer() {
  try {
    // Wait for mongoose to connect before doing anything that touches the DB
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ Connected to MongoDB Atlas');

    // Mount routes AFTER DB is connected
    const authRouter = require('./routes/auth');
    app.use('/api', authRouter);

    // 🔥 Notification routes
    const notificationRoutes = require('./routes/notifications');
    app.use(notificationRoutes);

    app.use(require('express-session')({
      secret: process.env.SESSION_SECRET || 'secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));

    // Create HTTP server and socket.io after routes
    const PORT = process.env.PORT || 5000;
    const server = http.createServer(app);

    // Socket.IO server configuration with better error handling
    const io = new Server(server, {
      cors: {
        // Use function for flexible CORS matching (same logic as Express CORS above)
        origin: function (origin, callback) {
          // Allow requests with no origin (like mobile apps or Capacitor webviews)
          if (!origin) {
            return callback(null, true);
          }

          // List of allowed origins
          const allowedOrigins = [
            'http://localhost',
            'https://localhost',
            'capacitor://localhost',
            'https://juicy.lcind.space',
            'https://juicyapp.in/',
            'https://juicyapp.in',
            'http://localhost:3000',
            'http://localhost:5000',
            'https://juicee-30ie.onrender.com',
            'https://juicy.lcind.space',
            'https://juicyapp.in/',
            'https://juicyapp.in//',
            process.env.FRONTEND_URL || 'http://localhost:3000'
          ];

          // Allow all localhost variants (for mobile testing on same network)
          if (origin.includes('localhost') ||
            origin.match(/^http:\/\/127\.0\.0\.\d+/) ||
            origin.match(/^http:\/\/192\.168\.\d+\.\d+/) ||
            origin.match(/^http:\/\/10\.\d+\.\d+\.\d+/) ||
            origin.match(/^https:\/\/localhost/)) {
            return callback(null, true);
          }

          if (allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            console.warn('Socket.IO CORS rejected origin:', origin);
            callback(new Error('Not allowed by Socket.IO CORS'), false);
          }
        },
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['my-custom-header']
      },
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000 // 2 minutes
      },
      maxHttpBufferSize: 5e7,
      // Use polling first to avoid noisy websocket upgrade failures in some environments
      transports: ['polling', 'websocket'],
      allowEIO3: true,
      pingTimeout: 60000,
      pingInterval: 25000
    });

    // If deploying to Render or other multi-instance hosts, you can provide
    // a REDIS_URL environment variable to enable the socket.io Redis adapter
    if (process.env.REDIS_URL) {
      try {
        const { createAdapter } = require('@socket.io/redis-adapter');
        const { createClient } = require('redis');
        const pubClient = createClient({ url: process.env.REDIS_URL });
        const subClient = pubClient.duplicate();
        await pubClient.connect();
        await subClient.connect();
        io.adapter(createAdapter(pubClient, subClient));
        console.log('✅ socket.io Redis adapter enabled');
      } catch (e) {
        console.error('❌ Failed to configure Redis adapter:', e);
      }
    }

    const activeOutgoingCalls = {};
    app.set('io', io);
    app.set('activeOutgoingCalls', activeOutgoingCalls);

    // Store socketId -> username mapping and socketId -> userId mapping
    const socketUsernames = {};
    const socketUserIds = {}; // socketId -> userId
    const onlineUsersSockets = {}; // userId -> Set of socketIds (tracks unique active connections)
    let usersInChat = {}; // { userId: chatWithId }
    const userAppStates = {}; // userId -> 'foreground' | 'background'

    // Helper to broadcast online users filtered by block status
    const broadcastOnlineUsers = async () => {
      try {
        const onlineUserIdsList = Object.keys(onlineUsersSockets).filter(id => onlineUsersSockets[id] && onlineUsersSockets[id].size > 0);

        // Find blocked relationship among online users
        const users = await User.find({
          _id: { $in: onlineUserIdsList }
        }).select('_id blockedUsers.userId');

        const blockMap = {};
        users.forEach(u => {
          blockMap[String(u._id)] = new Set(u.blockedUsers ? u.blockedUsers.map(b => String(b.userId)) : []);
        });

        const sockets = await io.fetchSockets();
        for (const s of sockets) {
          const sUserId = socketUserIds[s.id];
          if (!sUserId) continue;

          const filteredOnlineUsers = onlineUserIdsList.filter(otherId => {
            if (otherId === sUserId) return true;
            if (blockMap[sUserId] && blockMap[sUserId].has(otherId)) return false;
            if (blockMap[otherId] && blockMap[otherId].has(sUserId)) return false;
            return true;
          });

          s.emit('online_users', filteredOnlineUsers);
        }
      } catch (err) {
        console.error('Error broadcasting online users:', err);
      }
    };

    io.on('connection', (socket) => {
      console.log(`✅ User connected: ${socket.id} from ${socket.handshake.address}`);

      // Handle authentication
      const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
      if (userId && !String(userId).includes('-')) {
        socketUserIds[socket.id] = String(userId);
        if (!onlineUsersSockets[String(userId)]) {
          onlineUsersSockets[String(userId)] = new Set();
        }
        onlineUsersSockets[String(userId)].add(socket.id);
        console.log(`Socket ${socket.id} authenticated as user ${userId}`);

        // 🟢 CRITICAL FIX: Send current online users list immediately on connection
        broadcastOnlineUsers();
      }

      // Track app state (foreground/background)
      socket.on('app_state', ({ state }) => {
        const uid = socketUserIds[socket.id];
        if (uid) {
          userAppStates[uid] = state;
          console.log(`📱 User ${uid} app_state changed to: ${state}`);
        }
      });

      // Join QR linking room
      socket.on('join_qr_room', ({ sessionId }) => {
        if (sessionId) {
          socket.join(String(sessionId));
          console.log(`Socket ${socket.id} joined QR link room: ${sessionId}`);
        }
      });

      // Join room
      socket.on('join_room', async (userId, username) => {
        try {
          console.log('Socket joining room:', userId);
          const isCompositeRoom = String(userId).includes('-');
          socket.join(String(userId));

          if (isCompositeRoom) {
            console.log(`Socket ${socket.id} joined composite chat room ${userId}`);
            return;
          }

          socketUsernames[socket.id] = username;
          socketUserIds[socket.id] = String(userId);

          if (!onlineUsersSockets[String(userId)]) {
            onlineUsersSockets[String(userId)] = new Set();
          }
          onlineUsersSockets[String(userId)].add(socket.id);
          console.log(`Socket ${socket.id} joined user room ${userId} (active sockets=${onlineUsersSockets[String(userId)].size})`);

          // 📡 Auto-deliver call signal if there is a pending active call targeting this user
          for (const [cId, callDetails] of Object.entries(activeOutgoingCalls)) {
            if (String(callDetails.targetUserId) === String(userId)) {
              if (Date.now() - callDetails.timestamp < 90000) { // 90s — enough time to unlock screen and tap Answer
                console.log(`📡 Auto-delivering cached incoming call from ${cId} to ${userId}`);
                socket.emit('incomingCall', {
                  from: callDetails.from,
                  signal: callDetails.signal,
                  callerName: callDetails.callerName,
                  callType: callDetails.callType
                });
              } else {
                delete activeOutgoingCalls[cId];
              }
            }
          }

          // Clean up expired messages (older than 7 days) before delivering
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          await Message.deleteMany({
            $or: [
              { timestamp: { $lt: sevenDaysAgo } },
              { expiresAt: { $lt: new Date() } }
            ]
          });
          console.log('Cleaned up expired messages');

          // Deliver undelivered messages for this user (that are not expired)
          const undelivered = await Message.find({
            receiverId: userId,
            delivered: false,
            timestamp: { $gte: sevenDaysAgo }
          });
          undelivered.forEach(msg => {
            socket.emit('receive_message', msg);
          });

          // Mark as delivered
          await Message.updateMany({ receiverId: userId, delivered: false }, { $set: { delivered: true } });

          // 🟢 CRITICAL FIX: Broadcast updated online users to ALL clients
          await broadcastOnlineUsers();
        } catch (error) {
          console.error('Error in join_room:', error);
        }
      });

      // Leave room
      socket.on('leave_room', (roomId) => {
        socket.leave(roomId);
        console.log(`User left room: ${roomId}`);
      });

      // Join a chat room (conversation) so messages emitted to room deliver correctly
      socket.on('join_chat_room', ({ userId, chatWithId }) => {
        try {
          const roomId = [String(userId), String(chatWithId)].sort().join('-');
          socket.join(roomId);
          console.log(`Socket ${socket.id} joined chat room ${roomId}`);
        } catch (err) {
          console.error('join_chat_room error:', err);
        }
      });

      // Send message and broadcast to room
      socket.on('send_message', async (message, callback) => {
        try {
          const senderId = message.senderId;
          const receiverId = message.receiverId;

          // Check if sender blocked receiver (prevent sending)
          const isSenderBlockedReceiver = await User.countDocuments({
            _id: senderId,
            'blockedUsers.userId': receiverId
          }) > 0;

          if (isSenderBlockedReceiver) {
            if (callback) return callback({ status: 'blocked', error: 'You have blocked this contact. Unblock to send messages.' });
            return;
          }

          // Check if receiver blocked sender (stealth block)
          const isReceiverBlockedSender = await User.countDocuments({
            _id: receiverId,
            'blockedUsers.userId': senderId
          }) > 0;

          // ensure we have sender/receiver strings
          let senderUsername = message.senderUsername;
          let receiverUsername = message.receiverUsername;

          if ((!senderUsername || !receiverUsername) && message.senderId) {
            try {
              const s = await User.findById(message.senderId).select('username');
              if (s && !senderUsername) senderUsername = s.username;
            } catch (e) {
              console.warn('Could not lookup sender username', e.message);
            }
          }
          if ((!receiverUsername || !senderUsername) && message.receiverId) {
            try {
              const r = await User.findById(message.receiverId).select('username');
              if (r && !receiverUsername) receiverUsername = r.username;
            } catch (e) {
              console.warn('Could not lookup receiver username', e.message);
            }
          }

          const isVideo = message.type === 'video' && message.video;

          // If it's a video message, DO NOT store the large base64 in DB.
          // Save only lightweight metadata (optional) and emit the original base64 to sockets.
          let msgDoc = null;
          if (isVideo) {
            msgDoc = new Message({
              senderId: message.senderId,
              senderUsername: message.senderUsername,
              receiverId: message.receiverId,
              receiverUsername: message.receiverUsername,
              roomId: message.roomId,
              location: message.location || undefined,
              text: message.text || '',
              type: 'video',
              timestamp: new Date(),
              delivered: true, // mark delivered to avoid re-delivery from DB
              blocked: isReceiverBlockedSender
            });
            await msgDoc.save();
            console.log('Saved video metadata (no blob):', { id: msgDoc._id });
          } else {
            // non-video: save normally (including image/audio/document fields if present)
            msgDoc = new Message({
              senderId: message.senderId,
              senderUsername: message.senderUsername,
              receiverId: message.receiverId,
              receiverUsername: message.receiverUsername,
              roomId: message.roomId,
              text: message.text || '',
              type: message.type || 'text',
              image: message.image || undefined,
              audio: message.audio || undefined,
              document: message.document || undefined,
              documentData: message.documentData || undefined,
              contact: message.contact || undefined,
              location: message.location || undefined,
              timestamp: new Date(),
              delivered: false,
              blocked: isReceiverBlockedSender
            });
            await msgDoc.save();
            console.log('Saved message:', { id: msgDoc._id, type: msgDoc.type });
          }

          // Build emit payload: always include original base64 for immediate delivery
          const emitPayload = {
            _id: msgDoc._id,
            id: msgDoc._id,
            senderId: message.senderId,
            senderUsername: senderUsername || undefined,
            receiverId: message.receiverId,
            receiverUsername: receiverUsername || undefined,
            roomId: message.roomId,
            text: message.text || '',
            type: message.type || (isVideo ? 'video' : 'text'),
            timestamp: new Date(),
            video: isVideo ? message.video : undefined,
            image: message.image || undefined,
            audio: message.audio || undefined,
            document: message.document || undefined,
            documentData: message.documentData || undefined,
            contact: message.contact || undefined,
            location: message.location || undefined
          };

          console.log('EMIT payload ->', {
            id: emitPayload.id,
            type: emitPayload.type,
            hasVideo: !!emitPayload.video,
            senderUsername: emitPayload.senderUsername,
            receiverUsername: emitPayload.receiverUsername
          });

          const roomId = [message.senderId, message.receiverId].sort().join('-');

          // Emit to all relevant rooms (filter if receiver has blocked sender)
          if (isReceiverBlockedSender) {
            // Blocked message: Deliver ONLY to sender
            io.to(String(message.senderId)).emit('receive_message', emitPayload);
          } else {
            io.to(roomId).emit('receive_message', emitPayload);
            io.to(String(message.receiverId)).emit('receive_message', emitPayload);
            io.to(String(message.senderId)).emit('receive_message', emitPayload);
          }

          // 🔔 FCM Push: Send notification when receiver is not actively in this chat
          // FCM is always sent unless receiver is actively viewing THIS conversation.
          // This ensures background/terminated app delivery without relying on the
          // fragile app_state emit (which may not fire before Android suspends JS).
          if (!isReceiverBlockedSender) {
            try {
              const receiverUser = await User.findById(message.receiverId).select('fcmToken fcmTokens username');
              if (receiverUser && (receiverUser.fcmToken || (receiverUser.fcmTokens && receiverUser.fcmTokens.length > 0))) {
                // Only skip FCM if the receiver is ACTIVELY in this specific chat (real-time covers it)
                const isReceiverActivelyInThisChat =
                  usersInChat[String(message.receiverId)] === String(message.senderId) &&
                  onlineUsersSockets[String(message.receiverId)] &&
                  onlineUsersSockets[String(message.receiverId)].size > 0 &&
                  userAppStates[String(message.receiverId)] !== 'background';

                if (!isReceiverActivelyInThisChat) {
                  const senderUser = await User.findById(message.senderId).select('username profilePic');
                  if (senderUser) {
                    const msgPreview = message.type === 'image' ? '📷 Photo'
                      : message.type === 'video' ? '🎥 Video'
                        : message.type === 'audio' ? '🎵 Voice message'
                          : message.type === 'document' ? '📄 Document'
                            : message.type === 'contact' ? '👤 Contact'
                              : message.type === 'location' ? '📍 Location'
                                : (message.text || 'New message').substring(0, 100);

                    await sendMessageNotification(receiverUser, senderUser, msgPreview);
                    console.log('[FCM MESSAGE] Push sent to', receiverUser.username || message.receiverId,
                      '| receiver in chat:', usersInChat[String(message.receiverId)] === String(message.senderId),
                      '| online sockets:', onlineUsersSockets[String(message.receiverId)]?.size || 0,
                      '| app_state:', userAppStates[String(message.receiverId)] || 'unknown');
                  }
                } else {
                  console.log('[FCM MESSAGE] Skipped — receiver is actively in this chat');
                }
              }
            } catch (fcmErr) {
              console.error('[FCM MESSAGE] Push failed (message still delivered via socket):', fcmErr.message);
            }
          }

          if (callback) callback({ status: 'ok', messageId: msgDoc._id });
        } catch (error) {
          console.error('Error handling message:', error);
          if (callback) callback({ status: 'error', error: error.message });
        }
      });

      // (Legacy call signaling handlers removed to avoid duplicates)

      // Mark message as read (notify sender about read receipt)
      socket.on('mark_message_read', async ({ messageId, senderId }) => {
        try {
          // Update message in database
          await Message.findByIdAndUpdate(messageId, {
            read: true,
            readAt: new Date()
          });

          // Notify sender that message has been read
          io.to(String(senderId)).emit('message_read', { messageId });
        } catch (error) {
          console.error('Error marking message as read:', error);
        }
      });

      // Handle typing events and relay to other user in the room
      socket.on('typing', async ({ roomId, senderId }) => {
        try {
          const ids = roomId.split('-');
          const receiverId = ids.find(id => id !== String(senderId));
          if (receiverId) {
            const isBlockedRelation = await User.countDocuments({
              $or: [
                { _id: senderId, 'blockedUsers.userId': receiverId },
                { _id: receiverId, 'blockedUsers.userId': senderId }
              ]
            }) > 0;
            if (isBlockedRelation) return;
          }
          socket.to(roomId).emit('typing', { senderId });
        } catch (error) {
          console.error('typing handler error:', error);
        }
      });

      socket.on('stop_typing', async ({ roomId, senderId }) => {
        try {
          const ids = roomId.split('-');
          const receiverId = ids.find(id => id !== String(senderId));
          if (receiverId) {
            const isBlockedRelation = await User.countDocuments({
              $or: [
                { _id: senderId, 'blockedUsers.userId': receiverId },
                { _id: receiverId, 'blockedUsers.userId': senderId }
              ]
            }) > 0;
            if (isBlockedRelation) return;
          }
          socket.to(roomId).emit('stop_typing', { senderId });
        } catch (error) {
          console.error('stop_typing handler error:', error);
        }
      });

      // Edit message in database and notify room (with 15 minutes limit check)
      socket.on('edit_message', async ({ messageId, newText, roomId }) => {
        try {
          const msg = await Message.findById(messageId);
          if (!msg) {
            console.warn(`[edit_message] Message not found: ${messageId}`);
            return;
          }
          const msgTime = new Date(msg.timestamp || 0).getTime();
          if (isNaN(msgTime) || (Date.now() - msgTime > 15 * 60 * 1000)) {
            console.warn(`[edit_message] Attempted to edit message ${messageId} after 15 minutes limit.`);
            return;
          }

          msg.text = newText;
          msg.edited = true;
          await msg.save();

          // Broadcast to the chat room so recipient gets the update
          io.to(roomId).emit('message_edited', { messageId, newText });
        } catch (error) {
          console.error('Error editing message:', error);
        }
      });

      // Delete message from database and notify room (WhatsApp-style "Delete for Everyone" with 15 minutes limit check)
      socket.on('delete_message', async ({ messageId, roomId }) => {
        try {
          const msg = await Message.findById(messageId);
          if (!msg) {
            console.warn(`[delete_message] Message not found: ${messageId}`);
            return;
          }
          const msgTime = new Date(msg.timestamp || 0).getTime();
          if (isNaN(msgTime) || (Date.now() - msgTime > 15 * 60 * 1000)) {
            console.warn(`[delete_message] Attempted to delete message ${messageId} after 15 minutes limit.`);
            return;
          }

          // Save the original text to database so it persists across refreshes (crossed out)
          msg.originalText = msg.text || (msg.image ? '📷 Photo' : msg.audio ? '🎵 Voice message' : msg.document ? `📄 ${msg.document}` : 'Media');

          msg.text = 'This message was deleted';
          msg.type = 'deleted';
          msg.deletedForEveryone = true;
          msg.image = null;
          msg.audio = null;
          msg.document = null;
          msg.documentData = null;
          msg.contact = null;
          msg.youtube = null;
          await msg.save();

          // Broadcast deletion event with deletedForEveryone: true to the room so recipient gets the update
          io.to(roomId).emit('delete_message', { id: messageId, deletedForEveryone: true });
        } catch (error) {
          console.error('Error deleting message:', error);
        }
      });

      // Handle emoji reactions (WhatsApp-style)
      socket.on('react_message', async ({ messageId, emoji, roomId, userId, username }) => {
        try {
          const msg = await Message.findById(messageId);
          if (!msg) {
            console.warn(`Message not found for reaction: ${messageId}`);
            return;
          }

          if (!msg.reactions) {
            msg.reactions = [];
          }

          const existingIndex = msg.reactions.findIndex(r => String(r.userId) === String(userId));

          if (existingIndex !== -1) {
            if (msg.reactions[existingIndex].emoji === emoji) {
              // Toggle off if same emoji clicked again
              msg.reactions.splice(existingIndex, 1);
              console.log(`User ${userId} removed reaction ${emoji} from message ${messageId}`);
            } else {
              // Update emoji if different
              msg.reactions[existingIndex].emoji = emoji;
              console.log(`User ${userId} changed reaction to ${emoji} on message ${messageId}`);
            }
          } else {
            // Add new reaction
            msg.reactions.push({ userId, username, emoji });
            console.log(`User ${userId} reacted with ${emoji} to message ${messageId}`);
          }

          await msg.save();

          // Broadcast updated reactions to the chat room
          io.to(roomId).emit('message_reacted', {
            messageId,
            reactions: msg.reactions
          });
        } catch (error) {
          console.error('Error handling message reaction:', error);
        }
      });

      // Handle friend request sent - notify recipient in real-time
      socket.on('send_friend_request', (requestData) => {
        try {
          const { receiverId, senderId, senderUsername, senderProfilePic } = requestData;
          if (!receiverId) {
            console.error('No receiverId provided in friend request');
            return;
          }

          // Emit to recipient's user room
          io.to(String(receiverId)).emit('friend_request_received', {
            senderId: senderId,
            senderUsername: senderUsername,
            senderProfilePic: senderProfilePic,
            receiverId: receiverId,
            requestId: requestData.requestId,
            timestamp: requestData.timestamp
          });

          console.log(`Friend request sent from ${senderId} to ${receiverId}`);
        } catch (error) {
          console.error('Error sending friend request via socket:', error);
        }
      });

      // Share mood
      socket.on('share_mood', async (mood) => {
        try {
          const user = await User.findById(mood.userId);
          if (!user) return;

          // Get user's friends
          const friends = await User.find({
            'friends.friendId': mood.userId
          });

          // Broadcast to friends
          friends.forEach(friend => {
            socket.to(String(friend._id)).emit('receive_mood', mood);
          });
        } catch (error) {
          console.error('Error sharing mood via socket:', error);
        }
      });

      // Socket event to broadcast mood likes
      socket.on('like_mood', ({ moodId, targetUserId, likes, likerUserId, isLiked }) => {
        try {
          if (targetUserId) {
            socket.to(String(targetUserId)).emit('receive_mood_like', { moodId, targetUserId, likes, likerUserId, isLiked });
          }
          socket.broadcast.emit('receive_mood_like', { moodId, targetUserId, likes, likerUserId, isLiked });
        } catch (err) {
          console.error('Socket like_mood error:', err);
        }
      });

      // Handle in_chat status
      socket.on('in_chat', ({ userId, chatWith }) => {
        usersInChat[userId] = chatWith;
        io.emit('users_in_chat', usersInChat);
      });

      socket.on('left_chat', ({ userId }) => {
        delete usersInChat[userId];
        io.emit('users_in_chat', usersInChat);
      });

      // ===== WebRTC CALL SIGNALING HANDLERS (Audio & Video) =====
      // ✅ ENHANCED: Handle call initiation with better error handling and logging
      socket.on('callUser', async (data) => {
        try {
          const callerId = String(data.from);
          const receiverId = String(data.to);
          const callType = data.callType || 'audio';

          // Check if there is a block relation in either direction
          const isBlockedRelation = await User.countDocuments({
            $or: [
              { _id: callerId, 'blockedUsers.userId': receiverId },
              { _id: receiverId, 'blockedUsers.userId': callerId }
            ]
          }) > 0;

          if (isBlockedRelation) {
            console.log(`🚫 Call blocked between ${callerId} and ${receiverId} due to block relation`);
            socket.emit('callRejected', { reason: 'blocked' });
            return;
          }

          console.log(`📞 Call initiated from ${callerId} to ${receiverId} (${callType})`);
          console.log(`   Caller name: ${data.callerName}`);
          console.log(`   Signal size: ${data.signal ? Object.keys(data.signal).length : 0} bytes`);

          // Verify receiver exists in online users
          const receiverSockets = onlineUsersSockets[receiverId];
          if (!receiverSockets || receiverSockets.size <= 0) {
            console.log(`⚠️ Receiver ${receiverId} is not online via socket - relying on FCM push notification`);
          } else {
            console.log(`✅ Receiver ${receiverId} is online (${receiverSockets.size} socket(s))`);
          }

          // Check if receiver is also calling the caller (simultaneous calls = BUSY)
          if (activeOutgoingCalls[receiverId] && activeOutgoingCalls[receiverId].targetUserId === callerId) {
            console.log(`🚫 SIMULTANEOUS CALLS DETECTED! ${receiverId} is also calling ${callerId} - sending BUSY signal`);

            // Send busy signal to both caller and receiver
            io.to(String(callerId)).emit('callBusy', {
              from: receiverId,
              reason: 'line_busy',
              message: `${data.callerName} is already calling you`
            });

            io.to(String(receiverId)).emit('callBusy', {
              from: callerId,
              reason: 'line_busy',
              message: `Line busy - simultaneous calls`
            });

            // Clean up both active calls
            delete activeOutgoingCalls[callerId];
            delete activeOutgoingCalls[receiverId];
            return;
          }

          // Track this outgoing call
          activeOutgoingCalls[callerId] = {
            targetUserId: receiverId,
            from: callerId,
            signal: data.signal,
            callerName: data.callerName,
            callType: callType,
            timestamp: Date.now()
          };

          // Forward call signal to the receiver using 'incomingCall' event if online
          if (receiverSockets && receiverSockets.size > 0) {
            console.log(`📡 Forwarding call signal to online receiver ${receiverId}`);
            io.to(String(receiverId)).emit('incomingCall', {
              from: String(callerId), // ✅ CRITICAL: Ensure String
              signal: data.signal,
              callerName: data.callerName,
              callType: callType
            });
          }

          // 🔔 FCM Push: Send call notification always so the phone wakes up and rings
          try {
            const [callerUser, recipientUser] = await Promise.all([
              User.findById(callerId).select('username profilePic'),
              User.findById(receiverId).select('fcmToken fcmTokens username'),
            ]);
            if (recipientUser && (recipientUser.fcmToken || (recipientUser.fcmTokens && recipientUser.fcmTokens.length > 0)) && callerUser) {
              await sendCallNotification(recipientUser, callerUser, callType, data.signal);
              console.log('🔔 FCM call push sent to', recipientUser.username || receiverId);
            }
          } catch (fcmErr) {
            console.error('⚠️ FCM call push failed:', fcmErr.message);
          }

          console.log(`✅ Call initiation setup completed`);
        } catch (error) {
          console.error('❌ callUser handler error:', error);
        }
      });

      // ✅ ENHANCED: Handle call acceptance with better logging
      socket.on('answerCall', (data) => {
        try {
          const receiverId = String(data.to); // Caller ID (User A)
          const callerId = socketUserIds[socket.id]; // Answering ID (User B)

          console.log(`✅ Call answered from ${receiverId}'s side (answerer: ${callerId})`);
          console.log(`   Signal size: ${data.signal ? Object.keys(data.signal).length : 0} bytes`);

          // Remove from active outgoing calls since call was accepted
          if (activeOutgoingCalls[receiverId]) {
            delete activeOutgoingCalls[receiverId];
            console.log(`🧹 Cleaned up active call for caller ${receiverId}`);
          }
          if (activeOutgoingCalls[callerId]) {
            delete activeOutgoingCalls[callerId];
            console.log(`🧹 Cleaned up active call for answerer ${callerId}`);
          }

          // Forward answer signal to the caller
          console.log(`📡 Forwarding answer signal to caller ${receiverId}`);
          if (data.signal && typeof data.signal === 'object' && data.callId) {
            data.signal.callId = data.callId;
          }
          io.to(String(receiverId)).emit('callAccepted', data.signal);
          console.log(`✅ Answer signal sent successfully`);
        } catch (error) {
          console.error('❌ answerCall handler error:', error);
        }
      });

      // ✅ NEW: Handle trickle ICE candidates exchange
      socket.on('iceCandidate', (data) => {
        try {
          const targetUserId = String(data.to);
          const senderId = socketUserIds[socket.id];
          if (targetUserId) {
            console.log(`📡 Relaying trickle ICE candidate from ${senderId} to ${targetUserId}`);
            io.to(targetUserId).emit('iceCandidate', {
              from: senderId,
              candidate: data.candidate
            });
          }
        } catch (error) {
          console.error('❌ iceCandidate handler error:', error);
        }
      });

      // ✅ ENHANCED: Handle call rejection with better logging
      socket.on('rejectCall', (data) => {
        try {
          const callerId = socketUserIds[socket.id]; // User B
          const targetUserId = String(data.to);      // User A
          console.log(`❌ Call rejected by ${callerId}, notifying ${targetUserId}`);

          // Remove from active outgoing calls
          if (activeOutgoingCalls[callerId]) {
            delete activeOutgoingCalls[callerId];
          }
          if (activeOutgoingCalls[targetUserId]) {
            delete activeOutgoingCalls[targetUserId];
          }

          // Notify the caller that their call was rejected
          console.log(`📡 Sending callRejected to ${targetUserId}`);
          io.to(String(targetUserId)).emit('callRejected');
          console.log(`✅ Rejection notification sent`);
        } catch (error) {
          console.error('❌ rejectCall handler error:', error);
        }
      });

      // ✅ ENHANCED: Handle call end with better logging
      socket.on('endCall', async (data) => {
        try {
          const callerId = socketUserIds[socket.id];
          const receiverId = String(data.to);
          console.log(`📴 Call ended by ${callerId}, notifying ${receiverId}`);

          // Remove from active outgoing calls
          if (activeOutgoingCalls[callerId]) {
            delete activeOutgoingCalls[callerId];
          }
          if (activeOutgoingCalls[receiverId]) {
            delete activeOutgoingCalls[receiverId];
          }

          // Notify the other party that the call ended
          console.log(`📡 Sending callEnded to ${receiverId}`);
          io.to(String(receiverId)).emit('callEnded');
          console.log(`✅ Call end notification sent`);

          // Send FCM cancel_call push notification in case they are in the background
          try {
            const recipientUser = await User.findById(receiverId).select('fcmToken fcmTokens');
            if (recipientUser && (recipientUser.fcmToken || (recipientUser.fcmTokens && recipientUser.fcmTokens.length > 0))) {
              await sendNotificationToUser(recipientUser, {
                title: 'Call Ended',
                body: 'Call ended',
                data: {
                  type: 'cancel_call',
                  senderId: callerId,
                }
              });
              console.log('[FCM CALL] cancel_call push sent to', receiverId);
            }
          } catch (fcmErr) {
            console.error('⚠️ FCM cancel_call push failed:', fcmErr.message);
          }
        } catch (error) {
          console.error('❌ endCall handler error:', error);
        }
      });


      // Handle socket errors
      socket.on('error', (error) => {
        console.error('Socket error:', error);
      });

      socket.on('connect_error', (error) => {
        console.error('Socket connect_error:', error);
      });

      socket.on('disconnect', async (reason) => {
        try {
          console.log(`❌ Client disconnected: ${socket.id}, reason: ${reason}`);

          const uid = socketUserIds[socket.id];
          if (uid && onlineUsersSockets[uid]) {
            onlineUsersSockets[uid].delete(socket.id);
            console.log(`📊 User ${uid} socket removed. Active sockets remaining: ${onlineUsersSockets[uid].size}`);

            if (onlineUsersSockets[uid].size === 0) {
              delete onlineUsersSockets[uid];
              // Update lastSeen timestamp when going fully offline
              User.findByIdAndUpdate(uid, { lastSeen: new Date() })
                .then(() => console.log(`💾 Saved lastSeen for user ${uid}`))
                .catch(err => console.error(`Failed to save lastSeen for user ${uid}:`, err));
            }
          }

          // Clean up mappings
          delete socketUserIds[socket.id];
          delete socketUsernames[socket.id];

          // Remove from usersInChat if this user is tracked
          if (uid && usersInChat[uid]) {
            delete usersInChat[uid];
          }

          // Clean up any active outgoing calls for this user
          if (uid && activeOutgoingCalls[uid]) {
            console.log(`Cleaning up active call for disconnected user ${uid}`);
            delete activeOutgoingCalls[uid];
          }

          // 🟢 CRITICAL FIX: Broadcast updated online users to ALL clients on disconnect
          await broadcastOnlineUsers();
          io.emit('users_in_chat', usersInChat);
        } catch (err) {
          console.error('Disconnect handler error:', err);
        }
      });

      // 🟢 CRITICAL FIX: Handle client request for current online users
      socket.on('request_online_users', () => {
        try {
          broadcastOnlineUsers();
        } catch (error) {
          console.error('request_online_users handler error:', error);
        }
      });

      // Simple compatibility alias used by some clients: broadcast raw message payload
      socket.on('sendMessage', (data) => {
        try {
          io.emit('receiveMessage', data);
        } catch (e) {
          console.error('sendMessage handler error:', e);
        }
      });
    });

    // Simple healthcheck route (non-destructive)
    app.get('/', (req, res) => res.send('Server is running...'));

    // Start listening on all IPv4 and IPv6 interfaces
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

    // Function to clean up expired messages
    const cleanupExpiredMessages = async () => {
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const result = await Message.deleteMany({
          $or: [
            { timestamp: { $lt: sevenDaysAgo } },
            { expiresAt: { $lt: new Date() } }
          ]
        });
        console.log(`✅ Expired messages cleanup: Deleted ${result.deletedCount} messages`);
      } catch (err) {
        console.error('❌ Error cleaning up expired messages:', err);
      }
    };

    // Run cleanup on startup
    await cleanupExpiredMessages();

    // Schedule periodic cleanup every 24 hours
    setInterval(cleanupExpiredMessages, 24 * 60 * 60 * 1000);

    // Function to clean up expired moods (older than 24 hours) from all users
    const cleanupExpiredMoods = async () => {
      try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const result = await User.updateMany(
          {},
          { $pull: { moods: { timestamp: { $lt: twentyFourHoursAgo } } } }
        );
        console.log(`🧹 Expired moods cleanup: Removed expired moods from DB. Users modified: ${result.modifiedCount}`);
      } catch (err) {
        console.error('❌ Error cleaning up expired moods:', err);
      }
    };

    // Run cleanup on startup
    await cleanupExpiredMoods();

    // Schedule periodic cleanup every 1 hour
    setInterval(cleanupExpiredMoods, 60 * 60 * 1000);

    // Run cleanup after DB is ready
    try {
      const cleanupOrphans = require('./scripts/cleanupOrphans');
      cleanupOrphans().catch(err => console.error('cleanupOrphans startup error:', err));
      // schedule periodic cleanup (example every 6 hours)
      setInterval(() => {
        cleanupOrphans().catch(err => console.error('cleanupOrphans interval error:', err));
      }, 6 * 60 * 60 * 1000);
    } catch (err) {
      console.log('cleanupOrphans script not found or error:', err.message);
    }

  } catch (err) {
    console.error('Server startup error:', err);
    process.exit(1);
  }
}

startServer();