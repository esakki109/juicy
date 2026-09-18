/**
 * Push Notification Service - Backend
 * Sends FCM notifications to users across multiple devices
 * 
 * Note: Firebase Admin SDK is initialized in server.js
 * This service uses the already-initialized admin instance
 */

const admin = require('firebase-admin');
const User = require('../models/User');

/**
 * Extract deduplicated tokens array and user object reference
 */
async function extractTokensAndUser(target) {
  let tokens = [];
  let userObj = null;

  if (!target) return { tokens: [], userObj: null };

  if (typeof target === 'string') {
    // Target is a raw token string
    tokens = [target];
  } else if (Array.isArray(target)) {
    // Target is an array of token strings
    tokens = target.map(t => (typeof t === 'string' ? t : t?.token)).filter(Boolean);
  } else if (typeof target === 'object') {
    userObj = target;

    if (Array.isArray(target.fcmTokens) && target.fcmTokens.length > 0) {
      tokens = target.fcmTokens.map(t => (typeof t === 'string' ? t : t?.token)).filter(Boolean);
    }
    if (target.fcmToken && !tokens.includes(target.fcmToken)) {
      tokens.push(target.fcmToken);
    }

    // If no tokens found directly on user object, fetch from database using _id
    if (tokens.length === 0 && target._id) {
      try {
        const dbUser = await User.findById(target._id).select('fcmToken fcmTokens');
        if (dbUser) {
          userObj = dbUser;
          if (Array.isArray(dbUser.fcmTokens) && dbUser.fcmTokens.length > 0) {
            tokens = dbUser.fcmTokens.map(t => t.token).filter(Boolean);
          }
          if (dbUser.fcmToken && !tokens.includes(dbUser.fcmToken)) {
            tokens.push(dbUser.fcmToken);
          }
        }
      } catch (err) {
        console.error('❌ Error fetching user tokens from DB:', err.message);
      }
    }
  }

  // Deduplicate and filter out empty tokens
  const uniqueTokens = [...new Set(tokens)].filter(t => typeof t === 'string' && t.trim().length > 0);
  return { tokens: uniqueTokens, userObj };
}

/**
 * Remove invalid tokens from database for a user
 */
async function cleanInvalidTokens(userObj, invalidTokens) {
  if (!invalidTokens || invalidTokens.length === 0) return;
  try {
    if (userObj && typeof userObj.removeFCMToken === 'function') {
      for (const invToken of invalidTokens) {
        await userObj.removeFCMToken(invToken);
      }
      console.log(`🧹 Removed ${invalidTokens.length} invalid FCM token(s) from user ${userObj._id}`);
    } else if (userObj && userObj._id) {
      const dbUser = await User.findById(userObj._id);
      if (dbUser && typeof dbUser.removeFCMToken === 'function') {
        for (const invToken of invalidTokens) {
          await dbUser.removeFCMToken(invToken);
        }
        console.log(`🧹 Removed ${invalidTokens.length} invalid FCM token(s) from user ${dbUser._id}`);
      }
    } else {
      // Find any user with these tokens and remove them
      const users = await User.find({
        $or: [
          { 'fcmTokens.token': { $in: invalidTokens } },
          { fcmToken: { $in: invalidTokens } }
        ]
      });
      for (const u of users) {
        for (const invToken of invalidTokens) {
          await u.removeFCMToken(invToken);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error cleaning invalid FCM tokens:', err.message);
  }
}

/**
 * Send notification to a specific user or list of tokens
 * Uses DATA-ONLY messages so Android MyFirebaseMessagingService always fires
 * (even in background/killed state) on every registered device.
 * 
 * @param {object|string|Array} recipientUserOrToken - Recipient User object or FCM token(s)
 * @param {object} notification - Notification payload
 */
async function sendNotificationToUser(recipientUserOrToken, notification) {
  const { tokens, userObj } = await extractTokensAndUser(recipientUserOrToken);

  if (tokens.length === 0) {
    console.warn('⚠️ No FCM tokens found for recipient');
    return null;
  }

  // Convert all data values to strings (FCM data payload requires string values)
  const dataPayload = {};
  if (notification.data) {
    for (const [key, value] of Object.entries(notification.data)) {
      dataPayload[key] = String(value || '');
    }
  }
  // Include title and body in data payload so MyFirebaseMessagingService can read them
  dataPayload.title = notification.title || '';
  dataPayload.body = notification.body || '';
  if (notification.channelId) dataPayload.channelId = notification.channelId;
  if (notification.imageUrl) dataPayload.imageUrl = notification.imageUrl;

  // Safeguard: FCM has a strict 4096-byte payload limit. Ensure dataPayload stays well within limit.
  try {
    let payloadSize = Buffer.byteLength(JSON.stringify(dataPayload), 'utf8');
    if (payloadSize > 3500) {
      console.warn(`⚠️ [FCM] dataPayload size (${payloadSize} bytes) exceeds safety threshold. Trimming non-essential fields.`);
      if (dataPayload.signal) dataPayload.signal = '';
      if (dataPayload.imageUrl && Buffer.byteLength(JSON.stringify(dataPayload), 'utf8') > 3500) {
        delete dataPayload.imageUrl;
      }
      if (dataPayload.callerImage && Buffer.byteLength(JSON.stringify(dataPayload), 'utf8') > 3500) {
        delete dataPayload.callerImage;
      }
    }
  } catch (e) {
    console.warn('⚠️ [FCM] Payload size check warning:', e.message);
  }

  const multicastMessage = {
    tokens: tokens,
    // DATA-ONLY message — no "notification" key — ensures onMessageReceived fires always
    data: dataPayload,
    android: {
      // HIGH priority wakes the device from Doze mode (like WhatsApp) with ttl: 0 for immediate delivery
      priority: 'high',
      ttl: 0,
    },
    apns: {
      headers: {
        'apns-priority': '10', // High priority for iOS
      },
      payload: {
        aps: {
          alert: {
            title: notification.title,
            body: notification.body,
          },
          sound: 'default',
          badge: 1,
          'content-available': 1, // Wake app in background on iOS
        },
      },
    },
  };

  try {
    console.log(`[FCM] Sending notification to ${tokens.length} token(s) | type: ${dataPayload.type || 'unknown'} | title: ${notification.title}`);
    const response = await admin.messaging().sendEachForMulticast(multicastMessage);
    console.log(`[FCM] Firebase send result: ${response.successCount} success, ${response.failureCount} failed (of ${tokens.length} tokens)`);

    const invalidTokens = [];
    if (response.failureCount > 0) {
      response.responses.forEach((resp, index) => {
        if (!resp.success && resp.error) {
          const code = resp.error.code || '';
          const msg = resp.error.message || '';
          console.error(`[FCM] Error for token [${tokens[index].substring(0, 8)}...]:`, code, msg);

          if (
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered' ||
            msg.includes('not registered') ||
            msg.includes('invalid')
          ) {
            invalidTokens.push(tokens[index]);
          }
        }
      });
    }

    if (invalidTokens.length > 0) {
      console.warn(`[FCM] Cleaning ${invalidTokens.length} invalid token(s)...`);
      await cleanInvalidTokens(userObj, invalidTokens);
    }

    return response;
  } catch (error) {
    console.error('[FCM] Error sending multicast notification:', error.code || error.message);
    return null;
  }
}

/**
 * Send message notification to recipient
 */
async function sendMessageNotification(recipientUser, sender, messageText) {
  const notification = {
    title: sender.username,
    body: messageText.substring(0, 100), // Truncate to 100 chars
    data: {
      senderId: sender._id.toString(),
      senderName: sender.username,
      conversationId: [sender._id, recipientUser._id].sort().join('-'),
      type: 'message',
      timestamp: new Date().toISOString(),
    },
    channelId: 'chat_messages',
    imageUrl: sender.profilePic, // Optional: sender's profile pic
  };

  return sendNotificationToUser(recipientUser, notification);
}

/**
 * Send incoming call notification
 */
async function sendCallNotification(recipientUser, caller, callType = 'audio', signal = null) {
  const notification = {
    title: `${caller.username} is calling...`,
    body: callType === 'video' ? 'Video call' : 'Voice call',
    data: {
      senderId: caller._id.toString(),
      senderName: caller.username,
      receiverId: recipientUser._id.toString(),
      type: 'incoming_call',
      callType: callType,
      callId: `call_${Date.now()}`,
      timestamp: new Date().toISOString(),
      callerImage: caller.profilePic || '',
      // Note: WebRTC SDP signals for video calls exceed FCM's 4KB payload limit.
      // Signaling is delivered in real-time over Socket.IO (activeOutgoingCalls),
      // so signal is kept empty in FCM push to ensure 100% reliable delivery for video calls.
      signal: '',
      sound: 'receiver',
    },
    channelId: 'call_notifications_v3',
  };

  return sendNotificationToUser(recipientUser, notification);
}

/**
 * Send friend request notification
 */
async function sendFriendRequestNotification(recipientUser, requester) {
  const notification = {
    title: 'Friend Request',
    body: `${requester.username} sent you a friend request`,
    data: {
      senderId: requester._id.toString(),
      senderName: requester.username,
      type: 'friend_request',
      timestamp: new Date().toISOString(),
    },
    channelId: 'friend_requests',
  };

  return sendNotificationToUser(recipientUser, notification);
}

/**
 * Send notification to multiple users (topic)
 */
async function sendTopicNotification(topic, notification) {
  // Convert all data values to strings
  const dataPayload = {};
  if (notification.data) {
    for (const [key, value] of Object.entries(notification.data)) {
      dataPayload[key] = String(value || '');
    }
  }
  dataPayload.title = notification.title || '';
  dataPayload.body = notification.body || '';

  const message = {
    data: dataPayload,
    topic: topic,
    android: {
      priority: 'high',
      ttl: 0,
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('✅ Topic notification sent:', response);
    return response;
  } catch (error) {
    console.error('❌ Error sending topic notification:', error);
    return null;
  }
}

/**
 * Subscribe user to topic
 */
async function subscribeToTopic(fcmTokens, topic) {
  try {
    await admin.messaging().subscribeToTopic(fcmTokens, topic);
    console.log(`✅ Subscribed to topic: ${topic}`);
  } catch (error) {
    console.error('❌ Error subscribing to topic:', error);
  }
}

/**
 * Unsubscribe user from topic
 */
async function unsubscribeFromTopic(fcmTokens, topic) {
  try {
    await admin.messaging().unsubscribeFromTopic(fcmTokens, topic);
    console.log(`✅ Unsubscribed from topic: ${topic}`);
  } catch (error) {
    console.error('❌ Error unsubscribing from topic:', error);
  }
}

module.exports = {
  sendNotificationToUser,
  sendMessageNotification,
  sendCallNotification,
  sendFriendRequestNotification,
  sendTopicNotification,
  subscribeToTopic,
  unsubscribeFromTopic,
};
