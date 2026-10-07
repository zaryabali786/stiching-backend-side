/**
 * Holds the Socket.IO server so services can broadcast without importing the server setup.
 * Every emit is a no-op until initSocket() has run (scripts, tests, REST-only usage).
 */
let io = null;

export const setIO = (instance) => {
  io = instance;
};

export const getIO = () => io;

export const emitTo = (room, event, payload) => {
  try {
    io?.to(room).emit(event, payload);
  } catch (err) {
    console.warn('[Socket] emit failed:', err.message);
  }
};

/** Room names, kept in one place so server and services agree. */
export const rooms = {
  user: (userId) => `user:${userId}`,
  order: (orderId) => `order:${orderId}`,
  // every admin, and the people of one partner who may read messages (never another partner's)
  admins: 'admins',
  partner: (partnerId) => `partner:${partnerId}`,
};
