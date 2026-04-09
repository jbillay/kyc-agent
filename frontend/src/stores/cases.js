import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useCasesStore = defineStore('cases', () => {
  const cases = ref([]);
  const currentCase = ref(null);
  const loading = ref(false);

  async function fetchCases(filters) {
    // TODO: GET /api/v1/cases with filters
  }

  async function fetchCase(id) {
    // TODO: GET /api/v1/cases/:id
  }

  async function createCase(data) {
    // TODO: POST /api/v1/cases
  }

  return { cases, currentCase, loading, fetchCases, fetchCase, createCase };
});
