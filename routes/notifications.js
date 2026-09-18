/**
 * Backend Routes for Push Notifications
 * Add these routes to your Express app (routes/notifications.js)
 */

const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Message = require('../models/Message');
const {
  sendMessageNotification,
  sendCallNotification,
  sendFriendRequestNotification,
} = require('../services/pushNotificationService');

const isBlocked = async (user1Id, user2Id) => {
  try {
    const count = await User.countDocuments({
      $or: [
        { _id: user1Id, 'blockedUsers.userId': user2Id },
        { _id: user2Id, 'blockedUsers.userId': user1Id }
      ]
    });
    return count > 0;
  } catch (err) {
    console.error('Error in isBlocked check:', err);
    return false;
  }
};

/**
 * Save or update FCM token for user
 * POST /api/user/:userId/fcm-token
 */
router.post('/api/user/:userId/fcm-token', async (req, res) => {
  try {
    const { userId } = req.params;
    const fcmToken = req.body.fcmToken || req.body.token;
    const device = req.body.device || 'unknown';

    if (!fcmToken) {
      return res.status(400).json({ error: 'FCM token required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`[FCM] Token received from device for user: ${userId} (device: ${device}, token prefix: ${fcmToken.substring(0, 8)}...)`);

    // Add token using schema method (handles deduplication and backward compatibility)
    await user.addFCMToken(fcmToken, device);

    console.log(`[FCM] Token saved for user: ${userId} | total tokens: ${user.fcmTokens ? user.fcmTokens.length : 0}`);

    res.json({
      success: true,
      message: 'FCM token saved',
      fcmToken: user.fcmToken,
      fcmTokensCount: user.fcmTokens ? user.fcmTokens.length : 0,
      fcmTokens: user.fcmTokens || [],
    });
  } catch (error) {
    console.error('[FCM] Error saving FCM token:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send message notification
 * Called when a new message is sent
 * POST /api/notifications/send-message
 */
router.post('/api/notifications/send-message', async (req, res) => {
  try {
    const { senderId, receiverId, messageText } = req.body;

    if (!senderId || !receiverId || !messageText) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check block list before sending notification
    const blocked = await isBlocked(senderId, receiverId);
    if (blocked) {
      return res.json({ success: false, message: 'Notification blocked due to block list relationship' });
    }

    // Get sender and recipient user details
    const [sender, recipient] = await Promise.all([
      User.findById(senderId),
      User.findById(receiverId),
    ]);

    if (!sender || !recipient) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Send notification if recipient has any registered FCM token
    if (recipient.fcmToken || (recipient.fcmTokens && recipient.fcmTokens.length > 0)) {
      await sendMessageNotification(recipient, sender, messageText);
    }

    res.json({ success: true, message: 'Notification sent' });
  } catch (error) {
    console.error('Error sending message notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send incoming call notification
 * POST /api/notifications/send-call
 */
router.post('/api/notifications/send-call', async (req, res) => {
  try {
    const { callerId, recipientId, callType, signal } = req.body;

    if (!callerId || !recipientId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check block list before sending notification
    const blocked = await isBlocked(callerId, recipientId);
    if (blocked) {
      return res.json({ success: false, message: 'Notification blocked due to block list relationship' });
    }

    // Get caller and recipient user details
    const [caller, recipient] = await Promise.all([
      User.findById(callerId),
      User.findById(recipientId),
    ]);

    if (!caller || !recipient) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Send call notification
    if (recipient.fcmToken || (recipient.fcmTokens && recipient.fcmTokens.length > 0)) {
      await sendCallNotification(recipient, caller, callType || 'audio', signal);
    }

    res.json({ success: true, message: 'Call notification sent' });
  } catch (error) {
    console.error('Error sending call notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send friend request notification
 * POST /api/notifications/send-friend-request
 */
router.post('/api/notifications/send-friend-request', async (req, res) => {
  try {
    const { senderId, recipientId } = req.body;

    if (!senderId || !recipientId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check block list before sending notification
    const blocked = await isBlocked(senderId, recipientId);
    if (blocked) {
      return res.json({ success: false, message: 'Notification blocked due to block list relationship' });
    }

    // Get requester and recipient user details
    const [requester, recipient] = await Promise.all([
      User.findById(senderId),
      User.findById(recipientId),
    ]);

    if (!requester || !recipient) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Send friend request notification
    if (recipient.fcmToken || (recipient.fcmTokens && recipient.fcmTokens.length > 0)) {
      await sendFriendRequestNotification(recipient, requester);
    }

    res.json({ success: true, message: 'Friend request notification sent' });
  } catch (error) {
    console.error('Error sending friend request notification:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reject incoming call from background
 * POST /api/notifications/reject-call
 */
router.post('/api/notifications/reject-call', async (req, res) => {
  try {
    const { callerId, receiverId } = req.body;
    if (!callerId || !receiverId) {
      return res.status(400).json({ error: 'callerId and receiverId are required' });
    }

    console.log(`📞 Background reject-call received: callerId=${callerId}, receiverId=${receiverId}`);

    // Notify caller via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(String(callerId)).emit('callRejected', { by: receiverId });
      console.log(`Sent callRejected to caller room: ${callerId}`);
    }

    // Clean up active outgoing call cache
    const activeOutgoingCalls = req.app.get('activeOutgoingCalls');
    if (activeOutgoingCalls && activeOutgoingCalls[callerId]) {
      delete activeOutgoingCalls[callerId];
      console.log(`Cleaned up activeOutgoingCall cache for caller: ${callerId}`);
    }

    res.json({ success: true, message: 'Call rejected' });
  } catch (error) {
    console.error('Error rejecting call:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * [DEBUG] Test FCM push directly to a user by userId
 * POST /api/notifications/test-push
 * Body: { userId, type }  — type: 'message' | 'incoming_call'
 * Use this to verify the full FCM delivery path (Admin SDK → device → MyFirebaseMessagingService)
 * without sending a real message.
 */
router.post('/api/notifications/test-push', async (req, res) => {
  try {
    const { userId, type = 'message' } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const user = await User.findById(userId).select('fcmToken fcmTokens username');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.fcmToken && !(user.fcmTokens && user.fcmTokens.length > 0)) {
      return res.status(400).json({
        error: 'No FCM tokens registered for this user',
        hint: 'Open the app on the device and wait for the token to be saved'
      });
    }

    const { sendNotificationToUser } = require('../services/pushNotificationService');

    const notification = type === 'incoming_call'
      ? {
          title: 'Test Caller is calling...',
          body: 'Voice call',
          data: {
            type: 'incoming_call',
            callType: 'audio',
            senderId: userId,
            senderName: 'Test Caller',
            callId: `test_call_${Date.now()}`,
            channelId: 'call_notifications_v3',
            sound: 'receiver',
          }
        }
      : {
          title: 'Test Message',
          body: '[FCM TEST] If you see this in background, FCM is working!',
          data: {
            type: 'message',
            senderId: userId,
            senderName: user.username || 'Test',
            conversationId: `test_${Date.now()}`,
            channelId: 'chat_messages',
          }
        };

    const result = await sendNotificationToUser(user, notification);
    console.log(`[FCM TEST] Sent ${type} push to ${user.username || userId}`);

    res.json({
      success: true,
      type,
      username: user.username,
      tokenCount: (user.fcmTokens ? user.fcmTokens.length : 0) + (user.fcmToken ? 1 : 0),
      fcmResult: result ? { successCount: result.successCount, failureCount: result.failureCount } : null,
      message: 'FCM test push sent — check your device notification shade'
    });
  } catch (error) {
    console.error('[FCM TEST] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Send message from native Android notification inline reply (RemoteInput)
 * POST /api/messages/send-from-notification
 * Body: { senderId, receiverId, text, conversationId }
 */
router.post('/api/messages/send-from-notification', async (req, res) => {
  try {
    const { senderId, receiverId, text, conversationId } = req.body;

    if (!senderId || !receiverId || !text || !text.trim()) {
      return res.status(400).json({ error: 'senderId, receiverId, and non-empty text are required' });
    }

    const trimmedText = text.trim();

    // Fetch sender & recipient details
    const [sender, recipient] = await Promise.all([
      User.findById(senderId).select('username profilePic blockedUsers'),
      User.findById(receiverId).select('username profilePic fcmToken fcmTokens blockedUsers')
    ]);

    if (!sender || !recipient) {
      return res.status(404).json({ error: 'Sender or receiver user not found' });
    }

    // Check block list status
    const isSenderBlockedReceiver = await isBlocked(senderId, receiverId);

    const roomId = conversationId || [String(senderId), String(receiverId)].sort().join('-');

    // Create and save Message document to MongoDB Atlas
    const msgDoc = new Message({
      senderId: sender._id,
      senderUsername: sender.username,
      receiverId: recipient._id,
      receiverUsername: recipient.username,
      roomId: roomId,
      text: trimmedText,
      type: 'text',
      timestamp: new Date(),
      delivered: false,
      blocked: isSenderBlockedReceiver
    });

    await msgDoc.save();
    console.log('[JuicyReply Backend] Message saved to MongoDB:', { id: msgDoc._id, sender: sender.username, receiver: recipient.username });

    // Broadcast via Socket.IO if available
    const io = req.app.get('io');
    if (io) {
      const emitPayload = {
        _id: msgDoc._id,
        id: msgDoc._id,
        senderId: String(sender._id),
        senderUsername: sender.username,
        receiverId: String(recipient._id),
        receiverUsername: recipient.username,
        roomId: roomId,
        text: trimmedText,
        type: 'text',
        timestamp: msgDoc.timestamp
      };

      if (isSenderBlockedReceiver) {
        io.to(String(sender._id)).emit('receive_message', emitPayload);
      } else {
        io.to(roomId).emit('receive_message', emitPayload);
        io.to(String(recipient._id)).emit('receive_message', emitPayload);
        io.to(String(sender._id)).emit('receive_message', emitPayload);
      }
      console.log('[JuicyReply Backend] Emitted receive_message via Socket.IO');
    }

    // Send FCM Push Notification to recipient if not blocked
    if (!isSenderBlockedReceiver && (recipient.fcmToken || (recipient.fcmTokens && recipient.fcmTokens.length > 0))) {
      try {
        await sendMessageNotification(recipient, sender, trimmedText);
        console.log('[JuicyReply Backend] FCM push dispatched to recipient:', recipient.username);
      } catch (fcmErr) {
        console.error('[JuicyReply Backend] FCM dispatch warning:', fcmErr.message);
      }
    }

    res.json({
      success: true,
      messageId: msgDoc._id,
      message: 'Notification reply processed and persisted'
    });
  } catch (error) {
    console.error('[JuicyReply Backend] Error handling send-from-notification:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
