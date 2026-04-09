import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';

export const useWebSocketStore = defineStore('websocket', () => {
  const socket = ref(null);
  const connected = ref(false);

  function connect(token) {
    if (socket.value) return;
    const url = import.meta.env.VITE_WS_URL || '';
    socket.value = io(url, { auth: { token } });
    socket.value.on('connect', () => {
      connected.value = true;
    });
    socket.value.on('disconnect', () => {
      connected.value = false;
    });
  }

  function disconnect() {
    if (socket.value) {
      socket.value.disconnect();
      socket.value = null;
      connected.value = false;
    }
  }

  function on(event, handler) {
    if (!socket.value) return;
    socket.value.on(event, handler);
  }

  function off(event, handler) {
    if (!socket.value) return;
    socket.value.off(event, handler);
  }

  return { socket, connected, connect, disconnect, on, off };
});
