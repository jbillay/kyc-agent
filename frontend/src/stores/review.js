import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useReviewStore = defineStore('review', () => {
  const queue = ref([]);
  const loading = ref(false);

  async function fetchQueue() {
    // TODO: GET /api/v1/review
  }

  return { queue, loading, fetchQueue };
});
