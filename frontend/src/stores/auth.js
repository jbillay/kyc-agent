import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null);
  const token = ref(null);

  const isAuthenticated = computed(() => token.value !== null);

  async function login(email, password) {
    // TODO: POST /api/v1/auth/login
  }

  async function logout() {
    // TODO: POST /api/v1/auth/logout; clear user and token
    user.value = null;
    token.value = null;
  }

  async function refreshToken() {
    // TODO: POST /api/v1/auth/refresh
  }

  return { user, token, isAuthenticated, login, logout, refreshToken };
});
